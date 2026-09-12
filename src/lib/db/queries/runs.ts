import 'server-only';

import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';

import type { Db } from '@/lib/db/client';
import { newId, nowMs } from '@/lib/db/client';
import { runs, type RunRow } from '@/lib/db/schema';
import type { RunStatus, StepOrDone } from '@/shared/constants';
import type { AgentSnapshotEntry } from '@/shared/types';

/**
 * Run queries, sections 7.5, 14, 17.6 and 18.1.
 *
 * Raw rows out; the API layer maps to `RunSummary` / `RunDetailResponse`.
 * Drizzle's better-sqlite3 driver is synchronous: no `await` anywhere here.
 */

export type RunInsert = typeof runs.$inferInsert;
export type RunUpdate = Partial<
  Omit<RunInsert, 'id' | 'userId' | 'createdAt'>
>;

/**
 * Section 7.5: `config_snapshot` holds "budgets, stagger cadence, refine
 * enabled, search enabled". The spec does not name the type, so it is defined
 * here where the snapshot is written.
 */
export interface RunConfigSnapshot {
  budgetUsd: number;
  maxTokens: number;
  maxCalls: number;
  staggerCadenceMs: number;
  refineEnabled: boolean;
  searchEnabled: boolean;
}

/**
 * Create payload. `agent_snapshot` is typed as the frozen seat list from
 * `shared/types` rather than a bare JSON blob, because section 7.5 MUST: the
 * snapshot freezes provider, model, weight, temperature and lens prompt at run
 * start and later seat edits must never move a past run's arithmetic.
 */
export type RunCreateInput = Omit<
  RunInsert,
  'id' | 'createdAt' | 'agentSnapshot' | 'configSnapshot'
> & {
  agentSnapshot: AgentSnapshotEntry[];
  configSnapshot: RunConfigSnapshot;
};

export function createRun(db: Db, values: RunCreateInput): RunRow {
  const created = db
    .insert(runs)
    .values({ ...values, id: newId(), createdAt: nowMs() })
    .returning()
    .get();
  if (!created) throw new Error('runs insert did not persist');
  return created;
}

export function getRun(db: Db, id: string): RunRow | undefined {
  return db.select().from(runs).where(eq(runs.id, id)).get();
}

export interface ListRunsOptions {
  /** Defaults to 50, capped at 200 so a stray query cannot pull the table. */
  limit?: number;
  offset?: number;
  status?: RunStatus;
  /** Case-insensitive-ish substring filter on the seed prompt, section 18.1. */
  seedContains?: string;
  userId?: string;
}

const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 200;

function runFilters(opts: Omit<ListRunsOptions, 'limit' | 'offset'>): SQL | undefined {
  const conditions: SQL[] = [];
  if (opts.status) conditions.push(eq(runs.status, opts.status));
  if (opts.userId) conditions.push(eq(runs.userId, opts.userId));
  if (opts.seedContains) {
    // ESCAPE is explicit: SQLite's LIKE treats backslash as an ordinary
    // character unless told otherwise, so a seed containing `%` would
    // otherwise match everything.
    const pattern = `%${opts.seedContains.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(sql`${runs.seedPrompt} LIKE ${pattern} ESCAPE '\\'`);
  }
  return and(...conditions);
}

/** Newest first, section 18.1. `id` breaks ties on same-millisecond inserts. */
export function listRuns(db: Db, opts: ListRunsOptions = {}): RunRow[] {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_RUN_LIMIT), MAX_RUN_LIMIT);
  const offset = Math.max(0, opts.offset ?? 0);

  return db
    .select()
    .from(runs)
    .where(runFilters(opts))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit)
    .offset(offset)
    .all();
}

/** Total rows matching the same filters, for pagination. */
export function countRuns(
  db: Db,
  opts: Omit<ListRunsOptions, 'limit' | 'offset'> = {},
): number {
  const row = db
    .select({ value: count() })
    .from(runs)
    .where(runFilters(opts))
    .get();
  return row?.value ?? 0;
}

export function updateRun(
  db: Db,
  id: string,
  patch: RunUpdate,
): RunRow | undefined {
  return db.update(runs).set(patch).where(eq(runs.id, id)).returning().get();
}

/** Deletes the run; proposals, critiques, votes, events and messages cascade. */
export function deleteRun(db: Db, id: string): boolean {
  return db.delete(runs).where(eq(runs.id, id)).run().changes > 0;
}

/**
 * Section 17.6, boot sweep. In-flight runs do not survive a hard restart in
 * v1, so every `running` row is marked `failed` with `PROCESS_RESTART`. The
 * artefacts are left untouched: the run stays browsable and replayable.
 *
 * `paused` rows are deliberately not swept. A paused run is waiting on a user
 * action the UI can still deliver, and its engine re-enters the step on resume.
 *
 * Returns the number of rows swept, for the boot log.
 */
export function sweepStaleRuns(db: Db): number {
  return db
    .update(runs)
    .set({
      status: 'failed',
      errorCode: 'PROCESS_RESTART',
      errorMessage: 'The server restarted while this run was in flight.',
      completedAt: nowMs(),
    })
    .where(eq(runs.status, 'running'))
    .run().changes;
}

export interface RunUsageDelta {
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  llmCalls?: number;
}

/**
 * Accumulate the running usage totals (sections 7.5 and 17.2). The increments
 * happen in SQL rather than read-modify-write, so an interleaved call cannot
 * lose a counter update. Returns the updated row.
 */
export function bumpRunUsage(
  db: Db,
  id: string,
  delta: RunUsageDelta,
): RunRow | undefined {
  return db
    .update(runs)
    .set({
      tokensIn: sql`${runs.tokensIn} + ${delta.tokensIn ?? 0}`,
      tokensOut: sql`${runs.tokensOut} + ${delta.tokensOut ?? 0}`,
      costEstimateUsd: sql`${runs.costEstimateUsd} + ${delta.costUsd ?? 0}`,
      llmCalls: sql`${runs.llmCalls} + ${delta.llmCalls ?? 0}`,
    })
    .where(eq(runs.id, id))
    .returning()
    .get();
}

/** Convenience for the engine's step bookkeeping (section 11.2). */
export function setRunStep(
  db: Db,
  id: string,
  step: StepOrDone,
  stepIndex: number,
): RunRow | undefined {
  return updateRun(db, id, { currentStep: step, stepIndex });
}
