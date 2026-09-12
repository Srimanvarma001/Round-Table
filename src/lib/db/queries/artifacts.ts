import 'server-only';

import { and, asc, eq, type SQL } from 'drizzle-orm';

import type { Db } from '@/lib/db/client';
import { newId, nowMs } from '@/lib/db/client';
import {
  critiques,
  proposals,
  votes,
  type CritiqueRow,
  type ProposalRow,
  type VoteRow,
} from '@/lib/db/schema';

/**
 * Proposals, critiques and votes, sections 7.6 to 7.8.
 *
 * These three tables are the run's artefacts. They reference `agent_id` but
 * carry no foreign key to `agents`, deliberately: a seat can be deleted or
 * renamed while a completed run must stay replayable, and the run's own
 * `agent_snapshot` is what supplies the display name and accent (section 7.5).
 *
 * Drizzle's better-sqlite3 driver is synchronous: no `await` anywhere here.
 */

export type ProposalInsert = typeof proposals.$inferInsert;
export type CritiqueInsert = typeof critiques.$inferInsert;
export type VoteInsert = typeof votes.$inferInsert;

export type ProposalCreateInput = Omit<ProposalInsert, 'id' | 'createdAt'>;
export type CritiqueCreateInput = Omit<CritiqueInsert, 'id' | 'createdAt'>;
export type VoteCreateInput = Omit<VoteInsert, 'id' | 'createdAt'>;

// ---------------------------------------------------------------------------
// Proposals (section 7.6)
// ---------------------------------------------------------------------------

export function insertProposal(db: Db, values: ProposalCreateInput): ProposalRow {
  const created = db
    .insert(proposals)
    .values({ ...values, id: newId(), createdAt: nowMs() })
    .returning()
    .get();
  if (!created) throw new Error('proposals insert did not persist');
  return created;
}

export interface ListProposalsOptions {
  /** 1 for propose, 2 for refined (section 7.6). */
  round?: number;
  status?: 'active' | 'merged' | 'eliminated';
}

/** Insertion order within the round: the debate digests and tie-break depend on it. */
export function listProposals(
  db: Db,
  runId: string,
  opts: ListProposalsOptions = {},
): ProposalRow[] {
  const conditions: SQL[] = [eq(proposals.runId, runId)];
  if (opts.round !== undefined) conditions.push(eq(proposals.round, opts.round));
  if (opts.status) conditions.push(eq(proposals.status, opts.status));

  return db
    .select()
    .from(proposals)
    .where(and(...conditions))
    .orderBy(asc(proposals.round), asc(proposals.createdAt), asc(proposals.id))
    .all();
}

export function getProposal(db: Db, id: string): ProposalRow | undefined {
  return db.select().from(proposals).where(eq(proposals.id, id)).get();
}

export function updateProposalStatus(
  db: Db,
  id: string,
  status: 'active' | 'merged' | 'eliminated',
): ProposalRow | undefined {
  return db
    .update(proposals)
    .set({ status })
    .where(eq(proposals.id, id))
    .returning()
    .get();
}

// ---------------------------------------------------------------------------
// Critiques (section 7.7)
// ---------------------------------------------------------------------------

export function insertCritique(db: Db, values: CritiqueCreateInput): CritiqueRow {
  const created = db
    .insert(critiques)
    .values({ ...values, id: newId(), createdAt: nowMs() })
    .returning()
    .get();
  if (!created) throw new Error('critiques insert did not persist');
  return created;
}

export interface ListCritiquesOptions {
  targetProposalId?: string;
  round?: number;
  agentId?: string;
}

export function listCritiques(
  db: Db,
  runId: string,
  opts: ListCritiquesOptions = {},
): CritiqueRow[] {
  const conditions: SQL[] = [eq(critiques.runId, runId)];
  if (opts.targetProposalId) conditions.push(eq(critiques.targetProposalId, opts.targetProposalId));
  if (opts.round !== undefined) conditions.push(eq(critiques.round, opts.round));
  if (opts.agentId) conditions.push(eq(critiques.agentId, opts.agentId));

  return db
    .select()
    .from(critiques)
    .where(and(...conditions))
    .orderBy(asc(critiques.createdAt), asc(critiques.id))
    .all();
}

// ---------------------------------------------------------------------------
// Votes (section 7.8)
// ---------------------------------------------------------------------------

export function insertVote(db: Db, values: VoteCreateInput): VoteRow {
  const created = db
    .insert(votes)
    .values({ ...values, id: newId(), createdAt: nowMs() })
    .returning()
    .get();
  if (!created) throw new Error('votes insert did not persist');
  return created;
}

/**
 * Retry-safe write. Section 14 MUST: every run-mutating call is safe to repeat,
 * so a retried vote with the same idempotency key updates the existing row
 * instead of violating `votes_unique_idx`.
 */
export function upsertVote(db: Db, values: VoteCreateInput): VoteRow {
  const now = nowMs();
  const updated = db
    .insert(votes)
    .values({ ...values, id: newId(), createdAt: now })
    .onConflictDoUpdate({
      target: [votes.runId, votes.agentId, votes.proposalId],
      set: {
        score: values.score,
        weightAtVote: values.weightAtVote,
        weightedScore: values.weightedScore,
        comment: values.comment ?? '',
      },
    })
    .returning()
    .get();
  if (!updated) throw new Error('votes upsert did not persist');
  return updated;
}

export interface ListVotesOptions {
  proposalId?: string;
  agentId?: string;
}

export function listVotes(db: Db, runId: string, opts: ListVotesOptions = {}): VoteRow[] {
  const conditions: SQL[] = [eq(votes.runId, runId)];
  if (opts.proposalId) conditions.push(eq(votes.proposalId, opts.proposalId));
  if (opts.agentId) conditions.push(eq(votes.agentId, opts.agentId));

  return db
    .select()
    .from(votes)
    .where(and(...conditions))
    .orderBy(asc(votes.createdAt), asc(votes.id))
    .all();
}
