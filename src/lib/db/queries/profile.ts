import 'server-only';

import { and, asc, desc, eq, inArray, ne, notInArray, sql, type SQL } from 'drizzle-orm';

import type { Db } from '@/lib/db/client';
import { newId, nowMs } from '@/lib/db/client';
import {
  profileItems,
  profiles,
  type ProfileItemRow,
  type ProfileRow,
} from '@/lib/db/schema';
import { getSetting, setSetting } from '@/lib/db/queries/settings';
import type { ProfileItemKind, ProfileItemSource } from '@/shared/constants';
import type { IngestRunDTO } from '@/shared/types';

/**
 * Profiles and profile items, sections 7.2, 7.3, 10 and 14.
 *
 * Section 10.4's guarantees live partly here: locked and manual items are
 * never touched by regeneration (`updateProfileItem` is the only writer that
 * may flip `locked`, and `markItemsMissingFromExtraction` excludes them).
 *
 * Drizzle's better-sqlite3 driver is synchronous: no `await` anywhere here.
 */

export type ProfileInsert = typeof profiles.$inferInsert;
export type ProfileItemInsert = typeof profileItems.$inferInsert;

export type ProfileCreateInput = Omit<ProfileInsert, 'id'>;
export type ProfileUpdateInput = Partial<Omit<ProfileInsert, 'id' | 'userId'>>;
export type ProfileItemCreateInput = Omit<
  ProfileItemInsert,
  'id' | 'createdAt' | 'updatedAt'
>;
export type ProfileItemUpdateInput = Partial<
  Omit<ProfileItemInsert, 'id' | 'profileId' | 'createdAt' | 'updatedAt'>
>;

// ---------------------------------------------------------------------------
// profiles (section 7.2)
// ---------------------------------------------------------------------------

export function getProfile(db: Db, id: string): ProfileRow | undefined {
  return db.select().from(profiles).where(eq(profiles.id, id)).get();
}

/** Exactly one row per user is active. */
export function getActiveProfile(db: Db): ProfileRow | undefined {
  return db.select().from(profiles).where(eq(profiles.status, 'active')).get();
}

/** Newest version first. */
export function listProfiles(db: Db): ProfileRow[] {
  return db
    .select()
    .from(profiles)
    .orderBy(desc(profiles.version), desc(profiles.generatedAt))
    .all();
}

export function nextProfileVersion(db: Db): number {
  const row = db
    .select({ max: sql<number | null>`max(${profiles.version})` })
    .from(profiles)
    .get();
  return (row?.max ?? 0) + 1;
}

export function createProfile(db: Db, values: ProfileCreateInput): ProfileRow {
  const created = db
    .insert(profiles)
    .values({ ...values, id: newId() })
    .returning()
    .get();
  if (!created) throw new Error('profiles insert did not persist');
  return created;
}

export function updateProfile(
  db: Db,
  id: string,
  patch: ProfileUpdateInput,
): ProfileRow | undefined {
  return db.update(profiles).set(patch).where(eq(profiles.id, id)).returning().get();
}

/**
 * Section 14 `POST /api/profile/apply` and section 10.4: promoting a profile
 * archives whatever was active. Both writes happen in one transaction so the
 * "exactly one active row" invariant cannot be observed broken.
 */
export function activateProfile(db: Db, id: string): ProfileRow | undefined {
  const exists = getProfile(db, id);
  if (!exists) return undefined;

  return db.transaction((tx) => {
    tx.update(profiles)
      .set({ status: 'archived' })
      .where(and(eq(profiles.status, 'active'), ne(profiles.id, id)))
      .run();
    return tx
      .update(profiles)
      .set({ status: 'active' })
      .where(eq(profiles.id, id))
      .returning()
      .get();
  });
}

export function archiveProfile(db: Db, id: string): ProfileRow | undefined {
  return updateProfile(db, id, { status: 'archived' });
}

/** Stamp an edit, so the UI can show "last hand-edited" (section 7.2). */
export function touchProfileEdit(db: Db, id: string): ProfileRow | undefined {
  return updateProfile(db, id, { lastManualEditAt: nowMs() });
}

// ---------------------------------------------------------------------------
// profile_items (section 7.3)
// ---------------------------------------------------------------------------

export interface ListProfileItemsOptions {
  /** Section 10.4: items removed by a regeneration are hidden by default. */
  includeStale?: boolean;
  kind?: ProfileItemKind;
  source?: ProfileItemSource;
}

export function listProfileItems(
  db: Db,
  profileId: string,
  opts: ListProfileItemsOptions = {},
): ProfileItemRow[] {
  const conditions: SQL[] = [eq(profileItems.profileId, profileId)];
  if (!opts.includeStale) conditions.push(eq(profileItems.stale, false));
  if (opts.kind) conditions.push(eq(profileItems.kind, opts.kind));
  if (opts.source) conditions.push(eq(profileItems.source, opts.source));

  return db
    .select()
    .from(profileItems)
    .where(and(...conditions))
    .orderBy(asc(profileItems.kind), asc(profileItems.orderIndex), asc(profileItems.label))
    .all();
}

export function getProfileItem(db: Db, id: string): ProfileItemRow | undefined {
  return db.select().from(profileItems).where(eq(profileItems.id, id)).get();
}

export function insertProfileItem(
  db: Db,
  values: ProfileItemCreateInput,
): ProfileItemRow {
  const created = db
    .insert(profileItems)
    .values(withItemTimestamps(values))
    .returning()
    .get();
  if (!created) throw new Error('profile_items insert did not persist');
  return created;
}

/** Bulk insert in one transaction: extraction writes up to 12 items per source. */
export function insertProfileItems(
  db: Db,
  values: readonly ProfileItemCreateInput[],
): ProfileItemRow[] {
  if (values.length === 0) return [];
  return db.transaction((tx) =>
    values.map((value) => {
      const row = tx.insert(profileItems).values(withItemTimestamps(value)).returning().get();
      if (!row) throw new Error('profile_items insert did not persist');
      return row;
    }),
  );
}

export function updateProfileItem(
  db: Db,
  id: string,
  patch: ProfileItemUpdateInput,
): ProfileItemRow | undefined {
  return db
    .update(profileItems)
    .set({ ...patch, updatedAt: nowMs() })
    .where(eq(profileItems.id, id))
    .returning()
    .get();
}

export function deleteProfileItem(db: Db, id: string): boolean {
  return db.delete(profileItems).where(eq(profileItems.id, id)).run().changes > 0;
}

/** Mark an explicit set of items stale (hidden, not deleted). §10.4 rule 3. */
export function markProfileItemsStale(
  db: Db,
  profileId: string,
  itemIds: readonly string[],
): number {
  if (itemIds.length === 0) return 0;
  return db
    .update(profileItems)
    .set({ stale: true, updatedAt: nowMs() })
    .where(and(eq(profileItems.profileId, profileId), inArray(profileItems.id, [...itemIds])))
    .run().changes;
}

/**
 * Section 10.4 rule 3: generated items absent from a fresh extraction are
 * marked stale and hidden. Manual and locked items are exempt — rule 1 is what
 * makes regeneration safe, so they are never touched here.
 */
export function markItemsMissingFromExtraction(
  db: Db,
  profileId: string,
  keepIds: readonly string[],
): number {
  const protections: SQL[] = [
    eq(profileItems.profileId, profileId),
    eq(profileItems.locked, false),
    ne(profileItems.source, 'manual'),
  ];

  // `IN ()` is not valid SQL, so an empty keep-list drops the id filter
  // entirely rather than relying on the driver to expand an empty array:
  // everything unprotected in this profile goes stale.
  const where =
    keepIds.length > 0
      ? and(...protections, notInArray(profileItems.id, [...keepIds]))
      : and(...protections);

  return db
    .update(profileItems)
    .set({ stale: true, updatedAt: nowMs() })
    .where(where)
    .run().changes;
}

function withItemTimestamps(
  values: ProfileItemCreateInput,
): ProfileItemInsert {
  const now = nowMs();
  return { ...values, id: newId(), createdAt: now, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Ingest run log (section 14 `ingestRuns`)
// ---------------------------------------------------------------------------

/**
 * Section 14 returns `{ profile, items, ingestRuns }`, and `IngestRunDTO` is in
 * `shared/types`, but section 7 defines no `ingest_runs` table and `schema.ts`
 * is frozen. Rather than invent a table, the log is kept as a capped JSON array
 * under one settings key. If an `ingest_runs` table is ever added, only this
 * section changes.
 */
export const INGEST_RUNS_KEY = 'profile.ingest_runs';

/** Keep the list bounded: this is a UI history, not an audit log. */
export const MAX_INGEST_RUNS = 50;

export interface IngestRunInput {
  source: ProfileItemSource | string;
  startedAt: number;
  finishedAt?: number | null;
  itemCount?: number;
  error?: string | null;
  id?: string;
}

interface IngestRunsBlob {
  runs: IngestRunDTO[];
}

function readIngestRuns(db: Db): IngestRunDTO[] {
  const blob = getSetting<IngestRunsBlob>(db, INGEST_RUNS_KEY);
  return blob && Array.isArray(blob.runs) ? blob.runs : [];
}

/** Append one ingestion attempt, newest first. */
export function appendIngestRun(db: Db, entry: IngestRunInput): IngestRunDTO {
  const dto: IngestRunDTO = {
    id: entry.id ?? newId(),
    source: entry.source,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt ?? null,
    itemCount: entry.itemCount ?? 0,
    error: entry.error ?? null,
  };

  const runs = [dto, ...readIngestRuns(db)].slice(0, MAX_INGEST_RUNS);
  setSetting(db, INGEST_RUNS_KEY, { runs } satisfies IngestRunsBlob);
  return dto;
}

/** Close out an attempt opened by `appendIngestRun` (a two-phase ingest). */
export function finishIngestRun(
  db: Db,
  id: string,
  patch: { finishedAt?: number; itemCount?: number; error?: string | null },
): IngestRunDTO | undefined {
  const runs = readIngestRuns(db);
  const index = runs.findIndex((run) => run.id === id);
  if (index < 0) return undefined;

  const updated: IngestRunDTO = {
    ...runs[index],
    finishedAt: patch.finishedAt ?? nowMs(),
    itemCount: patch.itemCount ?? runs[index].itemCount,
    error: patch.error === undefined ? runs[index].error : patch.error,
  };
  runs[index] = updated;
  setSetting(db, INGEST_RUNS_KEY, { runs } satisfies IngestRunsBlob);
  return updated;
}

export function listIngestRuns(db: Db, limit = 20): IngestRunDTO[] {
  return readIngestRuns(db).slice(0, Math.max(0, limit));
}

export function clearIngestRuns(db: Db): void {
  setSetting(db, INGEST_RUNS_KEY, { runs: [] } satisfies IngestRunsBlob);
}
