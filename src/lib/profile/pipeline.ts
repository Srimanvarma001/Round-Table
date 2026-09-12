import 'server-only';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { profileItems, profiles, settings } from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import type { IngestRunDTO, ProfileDiff, RegenerateResponse } from '@/shared/types';
import { readCvDetailed, readLatestCv, type CvReadResult } from './cv';
import { extractProfileItems, type ExtractedProfileItem, type ExtractableSource } from './extract';
import { fetchGithubSignals, renderGithubSignalsForPrompt, type GithubFetchResult } from './github';
import { computeSourceHash } from './hash';
import { scanLocalProjects, renderLocalScanForPrompt, type LocalScanResult } from './localScan';
import {
  computeProfileDiff,
  mergeProfile,
  type MergedProfileItem,
  type ProfileItemLike,
} from './merge';
import { chunkTasteNotes, readTasteNotesDetailed, renderNotesForPrompt } from './notes';
import { renderProfileViews } from './summary';

/**
 * The profile pipeline, sections 10.1 to 10.6.
 *
 * Runs the selected ingestors, extracts items from each with one LLM call,
 * merges the result against the existing profile, renders both summaries and
 * writes a **draft** row at `version + 1`. It never activates anything: the
 * editor shows the diff, and `POST /api/profile/apply` promotes the draft
 * (section 10.4 rule 4).
 *
 * Failure policy, from section 10.6: "ingestion runs are recorded with
 * timestamp, source, item counts, and any error, displayed as a history list so
 * a failed GitHub fetch is visible rather than silent." So a source that fails
 * produces an ingest-run row with a non-null `error` and a warning, and the
 * pipeline carries on with the sources that worked (section 17.5). This
 * function is designed never to throw for an ingest, extraction or persistence
 * problem; a programming error can still surface as a rejected promise, but no
 * expected failure does.
 */

/** The sources the pipeline can run. `manual` is never generated (section 7.3). */
export const PROFILE_PIPELINE_SOURCES = ['github', 'cv', 'local_scan', 'notes'] as const;
export type ProfilePipelineSource = (typeof PROFILE_PIPELINE_SOURCES)[number];

/** Prompts are capped so one huge CV cannot blow the extraction budget. */
export const MAX_SOURCE_PROMPT_CHARS = 30_000;

/** Ingest history is kept short in the fallback store. */
export const MAX_INGEST_RUNS = 50;

/** The `settings` key the fallback store uses when no dedicated table exists. */
export const INGEST_RUNS_SETTING_KEY = 'profile.ingest_runs';

export interface StoredProfile {
  id: string;
  userId: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  summaryText: string;
  authorBrief: string;
  sourceHash: string;
  generatedAt: number;
  lastManualEditAt: number | null;
}

export interface ProfileDraftInput {
  userId: string;
  version: number;
  /** Every surviving item, including `stale` ones (they are hidden, not deleted). */
  items: readonly MergedProfileItem[];
  summaryText: string;
  authorBrief: string;
  sourceHash: string;
  generatedAt: number;
}

export interface IngestRunInput {
  userId: string;
  source: string;
  startedAt: number;
}

export interface IngestRunFinishInput {
  id: string;
  userId: string;
  source: string;
  startedAt: number;
  finishedAt: number;
  itemCount: number;
  error: string | null;
}

/**
 * The persistence seam.
 *
 * The default implementation talks to the frozen Drizzle schema directly, so
 * the pipeline cannot be broken by another module's naming. A caller that
 * prefers the shared CRUD helpers in `@/lib/db/queries/profile` can pass an
 * adapter implementing this interface through
 * `options.store` — the editor's route handler is the natural place to do that,
 * because it also owns activation and manual edits.
 */
export interface ProfileStore {
  /** The active profile and its items, falling back to the newest draft. */
  getCurrent(userId: string): Promise<{ profile: StoredProfile; items: ProfileItemLike[] } | null>;
  /** Insert a new `profiles` row (status `draft`) plus its items. */
  createDraft(input: ProfileDraftInput): Promise<{ profileId: string }>;
  /** Open an ingest-run record before the source is fetched. */
  startIngestRun(input: IngestRunInput): Promise<string>;
  /** Close it with an item count and, when it failed, the reason. */
  finishIngestRun(input: IngestRunFinishInput): Promise<void>;
}

export interface ProfilePipelineOptions {
  /** Bypass the GitHub cache and hit the API. */
  force?: boolean;
  /** Explicit CV path; defaults to the newest file in `data/uploads/`. */
  cvPath?: string;
  /** Folders to scan for `local_scan`; no default, because paths are user data. */
  localPaths?: readonly string[];
  /** Override `data/notes/taste.md`. */
  notesPath?: string;
  signal?: AbortSignal;
  now?: () => number;
  store?: ProfileStore;
}

export interface RunProfilePipelineInput {
  sources: readonly ProfilePipelineSource[];
  userId: string;
  options?: ProfilePipelineOptions;
}

/** Superset of `RegenerateResponse`, so the API route can return it unchanged. */
export interface ProfilePipelineResult extends RegenerateResponse {
  /** Empty when nothing could be persisted; the diff is still valid. */
  draftId: string;
  version: number;
  summaryText: string;
  authorBrief: string;
  sourceHash: string;
  items: MergedProfileItem[];
  ingestRuns: IngestRunDTO[];
  /** Always false: activation is a separate, explicit call (section 10.4 rule 4). */
  activated: false;
}

interface SourceIngest {
  source: ProfilePipelineSource;
  /** False when the source could not be read at all. */
  ok: boolean;
  error: string | null;
  warnings: string[];
  /** Prompt input for the extraction call. Empty when nothing was read. */
  text: string;
  /** Extra steer for the extraction prompt. */
  context?: string;
  /** Raw material fed into `source_hash`; null when the source was not run. */
  hashInput: string | null;
  items: ExtractedProfileItem[];
  ingestRun: IngestRunDTO;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the profile pipeline for a user. Returns a draft and a diff; writes
 * nothing active. Never throws for an expected failure.
 */
export async function runProfilePipeline(
  input: RunProfilePipelineInput,
): Promise<ProfilePipelineResult> {
  const now = input.options?.now ?? (() => Date.now());
  const store = input.options?.store ?? createDrizzleProfileStore();
  const warnings: string[] = [];

  const requested = [...new Set(input.sources)].filter((source) =>
    (PROFILE_PIPELINE_SOURCES as readonly string[]).includes(source),
  );
  if (requested.length === 0) {
    warnings.push('No profile sources were selected, so nothing was regenerated.');
  }

  // --- existing profile (section 10.4) ------------------------------------
  let current: { profile: StoredProfile; items: ProfileItemLike[] } | null = null;
  try {
    current = await store.getCurrent(input.userId);
  } catch (err) {
    logger.warn({ err, userId: input.userId }, 'profile.pipeline: could not load the current profile');
    warnings.push(`Could not load the current profile; the merge ran against an empty one (${message(err)}).`);
  }

  // --- run every selected source ------------------------------------------
  const ingests: SourceIngest[] = [];
  for (const source of requested) {
    if (input.options?.signal?.aborted) {
      warnings.push('The pipeline was cancelled; remaining sources were skipped.');
      break;
    }
    ingests.push(await runSource(source, input, store, now));
  }

  for (const ingest of ingests) {
    warnings.push(...ingest.warnings);
    if (ingest.error) warnings.push(`${ingest.source} ingestion failed: ${ingest.error}`);
  }

  // --- merge (section 10.4) ------------------------------------------------
  const extracted = ingests.flatMap((ingest) => ingest.items);
  const merged = mergeProfile(current?.items ?? [], extracted);
  warnings.push(...merged.warnings);

  // --- render (section 10.5) ----------------------------------------------
  const views = renderProfileViews(merged.items);

  // --- freshness (section 7.2) --------------------------------------------
  const hashParts: Record<string, string | null> = {};
  for (const source of PROFILE_PIPELINE_SOURCES) {
    const ingest = ingests.find((entry) => entry.source === source);
    hashParts[source] = ingest ? ingest.hashInput : null;
  }
  const sourceHash = computeSourceHash(hashParts);

  const diff: ProfileDiff = computeProfileDiff(current?.items ?? [], merged.items);
  const version = (current?.profile.version ?? 0) + 1;

  const result: ProfilePipelineResult = {
    draftId: '',
    version,
    diff,
    itemCount: merged.items.length,
    items: merged.items,
    summaryText: views.summaryText,
    authorBrief: views.authorBrief,
    sourceHash,
    warnings,
    ingestRuns: ingests.map((ingest) => ingest.ingestRun),
    activated: false,
  };

  if (merged.items.length === 0) {
    warnings.push('Nothing to save: the profile has no items after the merge.');
    return result;
  }

  // --- write the draft, never the active row -------------------------------
  try {
    const created = await store.createDraft({
      userId: input.userId,
      version,
      items: merged.items,
      summaryText: views.summaryText,
      authorBrief: views.authorBrief,
      sourceHash,
      generatedAt: now(),
    });
    result.draftId = created.profileId;
  } catch (err) {
    logger.error({ err, userId: input.userId }, 'profile.pipeline: could not persist the draft');
    warnings.push(
      `The draft could not be saved (${message(err)}). The diff above is still valid; review it and retry.`,
    );
  }

  logger.info(
    {
      userId: input.userId,
      sources: requested,
      added: merged.added,
      updated: merged.updated,
      staled: merged.staled,
      preserved: merged.preserved,
      version,
    },
    'profile.pipeline: draft generated',
  );

  return result;
}

// ---------------------------------------------------------------------------
// Per-source ingestion
// ---------------------------------------------------------------------------

async function runSource(
  source: ProfilePipelineSource,
  input: RunProfilePipelineInput,
  store: ProfileStore,
  now: () => number,
): Promise<SourceIngest> {
  const startedAt = now();
  const warnings: string[] = [];

  let ingestRunId = '';
  try {
    ingestRunId = await store.startIngestRun({ userId: input.userId, source, startedAt });
  } catch (err) {
    // Losing the history row must not stop the ingestion itself.
    logger.warn({ err, source }, 'profile.pipeline: could not open an ingest run');
  }

  let ingested: SourceIngest;
  try {
    ingested = await readSource(source, input, warnings);
  } catch (err) {
    // Defensive only: every ingestor handles its own failures.
    logger.error({ err, source }, 'profile.pipeline: ingestor threw');
    ingested = {
      source,
      ok: false,
      error: message(err),
      warnings,
      text: '',
      hashInput: null,
      items: [],
      ingestRun: emptyIngestRun(source, startedAt),
    };
  }

  // One LLM call per source (section 10.3), and only when there is something to
  // read.
  if (ingested.ok && ingested.text.trim().length > 0) {
    const extraction = await extractProfileItems(
      {
        source: ingested.source as ExtractableSource,
        text: ingested.text,
        context: ingested.context,
        signal: input.options?.signal,
      },
      {},
    );
    ingested.items = extraction.items;
    warnings.push(...extraction.warnings);
  } else if (ingested.ok) {
    warnings.push(`${source}: nothing was read, so no extraction call was made.`);
  }

  const finishedAt = now();
  const ingestRun: IngestRunDTO = {
    id: ingestRunId,
    source,
    startedAt,
    finishedAt,
    itemCount: ingested.items.length,
    error: ingested.error,
  };
  ingested.ingestRun = ingestRun;
  ingested.warnings = warnings;

  if (ingestRunId) {
    try {
      await store.finishIngestRun({
        id: ingestRunId,
        userId: input.userId,
        source,
        startedAt,
        finishedAt,
        itemCount: ingestRun.itemCount,
        error: ingestRun.error,
      });
    } catch (err) {
      logger.warn({ err, source }, 'profile.pipeline: could not close the ingest run');
    }
  }

  return ingested;
}

/** Dispatch to the right ingestor and normalise its output. */
async function readSource(
  source: ProfilePipelineSource,
  input: RunProfilePipelineInput,
  warnings: string[],
): Promise<SourceIngest> {
  const base = (partial: Partial<SourceIngest>): SourceIngest => ({
    source,
    ok: false,
    error: null,
    warnings,
    text: '',
    hashInput: null,
    items: [],
    ingestRun: emptyIngestRun(source, 0),
    ...partial,
  });

  switch (source) {
    case 'github': {
      const result: GithubFetchResult = await fetchGithubSignals({
        force: input.options?.force,
        signal: input.options?.signal,
        now: input.options?.now,
      });
      warnings.push(...result.warnings);
      if (!result.ok) {
        return base({ ok: false, error: result.error ?? 'GitHub ingestion failed.' });
      }
      return base({
        ok: true,
        text: truncateForPrompt(renderGithubSignalsForPrompt(result.signals), 'github', warnings),
        hashInput: JSON.stringify(result.signals),
        context: `${result.signals.repoCount} repositories; ${result.signals.abandoned.repoCount} dormant`,
      });
    }

    case 'cv': {
      // An explicit path wins; otherwise take the newest file the user dropped
      // into `data/uploads/`.
      const cvPath = input.options?.cvPath;
      const result: CvReadResult = cvPath ? await readCvDetailed(cvPath) : await readLatestCv();
      if (result.warning) warnings.push(result.warning);
      if (!result.ok || !result.text.trim()) {
        return base({ ok: result.ok, error: result.ok ? null : (result.warning ?? 'CV could not be read.') });
      }
      return base({
        ok: true,
        text: truncateForPrompt(result.text, 'cv', warnings),
        hashInput: result.text,
        context: `Extracted from ${result.format.toUpperCase()}`,
      });
    }

    case 'local_scan': {
      const paths = input.options?.localPaths ?? [];
      if (paths.length === 0) {
        return base({
          ok: false,
          error: 'No local project folders are configured. Add them on the profile page first.',
        });
      }
      const result: LocalScanResult = await scanLocalProjects(paths, { signal: input.options?.signal });
      warnings.push(...result.warnings);
      if (result.projects.length === 0) {
        return base({
          ok: false,
          error: `No readable project folders. Missing: ${result.missingPaths.join(', ') || 'none given'}.`,
        });
      }
      return base({
        ok: true,
        text: truncateForPrompt(renderLocalScanForPrompt(result), 'local_scan', warnings),
        hashInput: JSON.stringify(result),
        context: `${result.projects.length} projects scanned`,
      });
    }

    case 'notes': {
      const result = await readTasteNotesDetailed({ filePath: input.options?.notesPath });
      if (result.warning) warnings.push(result.warning);
      if (!result.exists || !result.text.trim()) {
        // Not an error: the user simply has not written notes yet.
        return base({ ok: true, text: '', hashInput: '' });
      }
      const chunks = chunkTasteNotes(result.text);
      return base({
        ok: true,
        text: truncateForPrompt(renderNotesForPrompt(chunks), 'notes', warnings),
        hashInput: result.text,
        context: `${chunks.length} note chunks`,
      });
    }

    default:
      return base({ ok: false, error: `Unknown profile source "${String(source)}".` });
  }
}

/** Bound the prompt input so a huge CV cannot eat the whole token budget. */
function truncateForPrompt(text: string, source: string, warnings: string[]): string {
  if (text.length <= MAX_SOURCE_PROMPT_CHARS) return text;
  warnings.push(
    `${source}: input truncated to ${MAX_SOURCE_PROMPT_CHARS} characters for extraction (${text.length} available).`,
  );
  return text.slice(0, MAX_SOURCE_PROMPT_CHARS);
}

function emptyIngestRun(source: string, startedAt: number): IngestRunDTO {
  return { id: '', source, startedAt, finishedAt: null, itemCount: 0, error: null };
}

// ---------------------------------------------------------------------------
// Default store: the frozen Drizzle schema
// ---------------------------------------------------------------------------

interface IngestRunRecord extends IngestRunDTO {
  userId: string;
}

/**
 * Default persistence, straight onto the frozen `profiles`, `profile_items` and
 * `settings` tables.
 *
 * The schema (section 7) has no `ingest_runs` table, so ingest history is kept
 * as a bounded JSON array on the `settings` row under
 * {@link INGEST_RUNS_SETTING_KEY}. That key is namespaced and harmless if a
 * dedicated table later replaces it — read the history through this store, not
 * through the raw table, and the swap is invisible.
 */
export function createDrizzleProfileStore(): ProfileStore {
  const db = getDb();

  return {
    async getCurrent(userId: string) {
      const rows = await db.select().from(profiles).where(eq(profiles.userId, userId));
      if (rows.length === 0) return null;

      const active = rows.find((row) => row.status === 'active');
      const newestDraft = rows
        .filter((row) => row.status === 'draft')
        .sort((a, b) => b.version - a.version)[0];
      const row = active ?? newestDraft;
      if (!row) return null;

      const itemRows = await db
        .select()
        .from(profileItems)
        .where(eq(profileItems.profileId, row.id));

      return {
        profile: {
          id: row.id,
          userId: row.userId,
          version: row.version,
          status: row.status,
          summaryText: row.summaryText,
          authorBrief: row.authorBrief,
          sourceHash: row.sourceHash,
          generatedAt: row.generatedAt,
          lastManualEditAt: row.lastManualEditAt ?? null,
        },
        items: itemRows
          .map((item) => ({
            id: item.id,
            kind: item.kind,
            label: item.label,
            detail: item.detail,
            source: item.source,
            confidence: item.confidence,
            locked: item.locked,
            stale: item.stale,
            orderIndex: item.orderIndex,
          }))
          .sort((a, b) => a.orderIndex - b.orderIndex),
      };
    },

    async createDraft(input: ProfileDraftInput) {
      const profileId = crypto.randomUUID();
      const stamp = input.generatedAt;

      // One transaction: a draft is the profile row plus its item rows, and a
      // half-written draft (profile without items) would corrupt version
      // numbering for every later run.
      db.transaction((tx) => {
        tx.insert(profiles).values({
          id: profileId,
          userId: input.userId,
          version: input.version,
          // A draft is never active on creation: section 10.4 rule 4.
          status: 'draft',
          summaryText: input.summaryText,
          authorBrief: input.authorBrief,
          sourceHash: input.sourceHash,
          generatedAt: stamp,
          lastManualEditAt: null,
        }).run();

        if (input.items.length > 0) {
          tx.insert(profileItems).values(
            input.items.map((item) => ({
              // Fresh rows for a new version. Merged items carry the ids of
              // the rows they were matched against, and those rows still
              // exist on the archived version — reusing the ids collides.
              // History stays intact because the old rows are never touched.
              id: crypto.randomUUID(),
              profileId,
              kind: item.kind,
              label: item.label,
              detail: item.detail,
              source: item.source,
              confidence: item.confidence,
              locked: item.locked,
              stale: item.stale,
              orderIndex: item.orderIndex,
              createdAt: stamp,
              updatedAt: stamp,
            })),
          ).run();
        }
      });

      return { profileId };
    },

    async startIngestRun(input: IngestRunInput) {
      const id = crypto.randomUUID();
      const record: IngestRunRecord = {
        id,
        userId: input.userId,
        source: input.source,
        startedAt: input.startedAt,
        finishedAt: null,
        itemCount: 0,
        error: null,
      };
      await appendIngestRun(db, record);
      return id;
    },

    async finishIngestRun(input: IngestRunFinishInput) {
      await finishIngestRun(db, input);
    },
  };
}

type Db = ReturnType<typeof getDb>;

async function readIngestRuns(db: Db, userId: string): Promise<IngestRunRecord[]> {
  const rows = await db.select().from(settings).where(eq(settings.key, INGEST_RUNS_SETTING_KEY)).limit(1);
  const value = rows[0]?.value;
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((entry): entry is IngestRunRecord => {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as Partial<IngestRunRecord>;
    return typeof candidate.id === 'string' && typeof candidate.source === 'string';
  }).filter((entry) => entry.userId === userId);
}

async function writeIngestRuns(db: Db, all: readonly IngestRunRecord[]): Promise<void> {
  const trimmed = all.slice(-MAX_INGEST_RUNS);
  const now = Date.now();
  await db
    .insert(settings)
    .values({ key: INGEST_RUNS_SETTING_KEY, value: trimmed, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: trimmed, updatedAt: now },
    });
}

async function appendIngestRun(db: Db, record: IngestRunRecord): Promise<void> {
  const existing = await readIngestRuns(db, record.userId);
  await writeIngestRuns(db, [...existing, record]);
}

async function finishIngestRun(db: Db, input: IngestRunFinishInput): Promise<void> {
  const existing = await readIngestRuns(db, input.userId);
  const next = existing.map((entry) =>
    entry.id === input.id
      ? { ...entry, finishedAt: input.finishedAt, itemCount: input.itemCount, error: input.error }
      : entry,
  );
  // The row was never opened (the store call failed): record it now rather than
  // losing the fact that the source ran and what it produced.
  if (!next.some((entry) => entry.id === input.id)) {
    next.push({
      id: input.id,
      userId: input.userId,
      source: input.source,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      itemCount: input.itemCount,
      error: input.error,
    });
  }
  await writeIngestRuns(db, next);
}

/** The ingest history for a user, newest first, for `GET /api/profile`. */
export async function listIngestRuns(userId: string, limit = 20): Promise<IngestRunDTO[]> {
  try {
    const rows = await readIngestRuns(getDb(), userId);
    return rows
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(1, limit))
      .map(({ id, source, startedAt, finishedAt, itemCount, error }) => ({
        id,
        source,
        startedAt,
        finishedAt,
        itemCount,
        error,
      }));
  } catch (err) {
    logger.warn({ err, userId }, 'profile.pipeline: could not read ingest runs');
    return [];
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
