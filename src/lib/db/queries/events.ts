import 'server-only';

import { and, asc, eq, gt, sql } from 'drizzle-orm';

import type { Db } from '@/lib/db/client';
import { nowMs } from '@/lib/db/client';
import { runEvents, type RunEventRow } from '@/lib/db/schema';
import type { StepName } from '@/shared/constants';
import type { RunEventType } from '@/shared/events';

/**
 * The append-only event log, sections 7.9, 13.3 and 13.4.
 *
 * `run_events` is the backbone of SSE reconnect and token-free replay: the
 * autoincrement `id` doubles as the `Last-Event-ID`, and `seq` is the per-run
 * monotonic counter the replay reducer orders by.
 *
 * Drizzle's better-sqlite3 driver is synchronous: no `await` anywhere here.
 */

/** Default cap for a replay page; the stream pages through the rest. */
const MAX_EVENT_PAGE = 1000;

export interface AppendEventInput {
  runId: string;
  type: RunEventType | string;
  /** Event-specific body, stored as JSON. */
  payload: unknown;
  agentId?: string | null;
  step?: StepName | string | null;
}

/** Next per-run sequence number. Starts at 1 for a new run. */
export function nextSeq(db: Db, runId: string): number {
  const row = db
    .select({ max: sql<number | null>`max(${runEvents.seq})` })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .get();
  return (row?.max ?? 0) + 1;
}

/**
 * Append one event. `seq` is computed inside the INSERT statement itself as a
 * correlated subquery, so two appends for the same run cannot both read the
 * same `max(seq)` and collide — which is what a read-then-write would do under
 * the eight-way concurrency of a step (section 17.1).
 *
 * The row's `id` is the autoincrement value the bus puts in the SSE `id:` field.
 */
export function appendEvent(db: Db, values: AppendEventInput): RunEventRow {
  const seqExpression = sql<number>`(
    SELECT COALESCE(MAX(${runEvents.seq}), 0) + 1
    FROM ${runEvents}
    WHERE ${runEvents.runId} = ${values.runId}
  )`;

  const created = db
    .insert(runEvents)
    .values({
      runId: values.runId,
      type: values.type,
      payload: values.payload,
      agentId: values.agentId ?? null,
      step: values.step ?? null,
      seq: seqExpression,
      createdAt: nowMs(),
    })
    .returning()
    .get();
  if (!created) throw new Error('run_events insert did not persist');
  return created;
}

/**
 * Events with `seq` greater than `afterSeq`, oldest first. `afterSeq = 0`
 * returns the whole log, which is what replay reads (section 18.2).
 */
export function listEvents(db: Db, runId: string, afterSeq = 0): RunEventRow[] {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .all();
}

/**
 * Section 13.4: on connect the SSE handler replays everything after the
 * client's `Last-Event-ID`, which is a `run_events.id`, not a `seq`.
 */
export function listEventsAfterId(
  db: Db,
  runId: string,
  afterId: number,
  limit = MAX_EVENT_PAGE,
): RunEventRow[] {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.id, afterId)))
    .orderBy(asc(runEvents.id))
    .limit(Math.min(Math.max(1, limit), MAX_EVENT_PAGE))
    .all();
}

/** Events strictly after a known seq, useful for a resume that tracks `seq`. */
export function listEventsAfterSeq(
  db: Db,
  runId: string,
  lastSeq: number,
  limit = MAX_EVENT_PAGE,
): RunEventRow[] {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, lastSeq)))
    .orderBy(asc(runEvents.seq))
    .limit(Math.min(Math.max(1, limit), MAX_EVENT_PAGE))
    .all();
}

export function getEvent(db: Db, id: number): RunEventRow | undefined {
  return db.select().from(runEvents).where(eq(runEvents.id, id)).get();
}

/** Highest event id written for a run, or 0 when it has none yet. */
export function lastEventId(db: Db, runId: string): number {
  const row = db
    .select({ max: sql<number | null>`max(${runEvents.id})` })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .get();
  return row?.max ?? 0;
}
