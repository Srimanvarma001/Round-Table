import 'server-only';

import { and, asc, eq, ne } from 'drizzle-orm';

import type { Db } from '@/lib/db/client';
import { newId, nowMs } from '@/lib/db/client';
import { agents, type AgentRow } from '@/lib/db/schema';

/**
 * Seat queries, section 7.4 and section 14.
 *
 * These helpers return RAW ROWS. Mapping to `AgentDTO` (which resolves
 * `avatar_svg_cache` into `avatarSvg`) happens in the API layer, per the
 * section 7.13 / section 15 boundary.
 *
 * Every function takes the Drizzle handle as its first argument so the
 * orchestrator can pass a transaction-scoped handle later without a rewrite.
 * Drizzle's better-sqlite3 driver is synchronous: no `await` anywhere here.
 */

export type AgentInsert = typeof agents.$inferInsert;
export type AgentUpdate = Partial<
  Omit<AgentInsert, 'id' | 'userId' | 'seatKey' | 'createdAt' | 'updatedAt'>
>;

/**
 * Insert payload. Ids are `crypto.randomUUID()` and timestamps are
 * `Date.now()`, both assigned here (section 7).
 */
export type AgentCreateInput = Omit<AgentInsert, 'id' | 'createdAt' | 'updatedAt'>;

/** Order seats the way the table places them: `order_index` then name. */
const SEAT_ORDER = [asc(agents.orderIndex), asc(agents.name)] as const;

export function listAgents(db: Db): AgentRow[] {
  return db.select().from(agents).orderBy(...SEAT_ORDER).all();
}

export function getAgent(db: Db, id: string): AgentRow | undefined {
  return db.select().from(agents).where(eq(agents.id, id)).get();
}

export function getAgentBySeatKey(db: Db, seatKey: string): AgentRow | undefined {
  return db.select().from(agents).where(eq(agents.seatKey, seatKey)).get();
}

/**
 * The single seat with `is_me_agent = true` (section 9.2). If a bug ever left
 * more than one row flagged, the lowest `order_index` wins so the table still
 * renders exactly one Me Agent.
 */
export function getMeAgent(db: Db): AgentRow | undefined {
  return db
    .select()
    .from(agents)
    .where(eq(agents.isMeAgent, true))
    .orderBy(...SEAT_ORDER)
    .get();
}

export function createAgent(db: Db, values: AgentCreateInput): AgentRow {
  const now = nowMs();
  const row: AgentInsert = {
    ...values,
    id: newId(),
    // Section 7.4: `avatar_seed` defaults to `seat_key`, so the same seat
    // always renders the same shape (section 16.3).
    avatarSeed: values.avatarSeed ? values.avatarSeed : values.seatKey,
    createdAt: now,
    updatedAt: now,
  };

  const created = db.insert(agents).values(row).returning().get();
  if (!created) throw new Error('agents insert did not persist');
  return created;
}

/**
 * Partial update. `updated_at` is stamped here, and `seat_key` is deliberately
 * not updatable: it is the machine key that run snapshots and the icon map are
 * built from (section 7.4).
 */
export function updateAgent(
  db: Db,
  id: string,
  patch: AgentUpdate,
): AgentRow | undefined {
  return db
    .update(agents)
    .set({ ...patch, updatedAt: nowMs() })
    .where(eq(agents.id, id))
    .returning()
    .get();
}

export type DeleteAgentResult =
  | { deleted: true; id: string }
  | { deleted: false; id: string; reason: 'not_found' | 'me_agent' };

/**
 * Section 14: "Refuses to delete the Me Agent seat". A refusal is a normal
 * outcome, not an exception, so the API layer maps `reason` to 409 or 404
 * without catching anything.
 */
export function deleteAgent(db: Db, id: string): DeleteAgentResult {
  const existing = getAgent(db, id);
  if (!existing) return { deleted: false, id, reason: 'not_found' };
  if (existing.isMeAgent) return { deleted: false, id, reason: 'me_agent' };

  db.delete(agents).where(eq(agents.id, id)).run();
  return { deleted: true, id };
}

/**
 * Section 7.4: "Exactly one row may be true". There is no SQLite constraint
 * for that, so this is the guarantee. Call it after flagging a seat as the Me
 * Agent, with that seat's id as `keepId`; it clears the flag on every other
 * row and returns how many it cleared.
 */
export function ensureUniqueMeAgent(db: Db, keepId: string): number {
  const result = db
    .update(agents)
    .set({ isMeAgent: false, updatedAt: nowMs() })
    .where(and(eq(agents.isMeAgent, true), ne(agents.id, keepId)))
    .run();
  return result.changes;
}

/** Cache a generated avatar (section 16.3). Null clears it, forcing a reroll. */
export function setAgentAvatarCache(
  db: Db,
  id: string,
  svg: string | null,
): AgentRow | undefined {
  return updateAgent(db, id, { avatarSvgCache: svg });
}
