import {
  DISSENT_MEAN_MARGIN,
  DISSENT_WINNER_FLOOR,
  MAX_SCORE,
  MIN_SCORE,
} from '@/shared/constants';

/**
 * Scoring and voting math, section 12. The single implementation of this
 * arithmetic; both the server and the tests import it and the client never
 * reimplements it (section 15.2).
 */

export class WeightError extends Error {
  readonly code = 'INVALID_TRANSITION';
  constructor(message: string) {
    super(message);
    this.name = 'WeightError';
  }
}

export interface WeightableSeat {
  id: string;
  weight: number;
  enabled: boolean;
}

/**
 * Normalise raw weights over the ENABLED seats only (section 12.1).
 * Normalising over the enabled set is what makes disabling or adding a seat
 * rebalance automatically with no manual weight editing.
 */
export function normaliseWeights(seats: readonly WeightableSeat[]): Record<string, number> {
  const enabled = seats.filter((s) => s.enabled);

  if (enabled.length === 0) {
    throw new WeightError('Cannot normalise weights: no enabled seats.');
  }

  const total = enabled.reduce((sum, s) => sum + Math.max(0, s.weight), 0);

  if (!(total > 0)) {
    throw new WeightError(
      'Cannot normalise weights: total weight of enabled seats is zero.',
    );
  }

  const out: Record<string, number> = {};
  for (const seat of enabled) out[seat.id] = Math.max(0, seat.weight) / total;
  // Disabled seats are explicitly zero rather than absent, so a caller that
  // iterates every seat still gets a defined number.
  for (const seat of seats) if (!seat.enabled) out[seat.id] = 0;
  return out;
}

export interface ScoreInput {
  agentId: string;
  score: number;
}

export interface ProposalScoreBreakdown {
  finalScore: number;
  meanScore: number;
  voteCount: number;
  perSeat: Array<{ agentId: string; score: number; weight: number; weighted: number }>;
}

/**
 * `final_score(p) = Σ over enabled agents ( score × normalisedWeight )`.
 * Recalculated from stored vote rows rather than cached, so a display bug
 * cannot corrupt the outcome.
 */
export function scoreProposal(
  votes: readonly ScoreInput[],
  normalised: Record<string, number>,
): ProposalScoreBreakdown {
  let finalScore = 0;
  let sum = 0;
  let count = 0;
  const perSeat: ProposalScoreBreakdown['perSeat'] = [];

  for (const vote of votes) {
    const weight = normalised[vote.agentId];
    if (weight === undefined) continue; // seat was disabled; its vote is inert
    const score = clampScore(vote.score);
    const weighted = score * weight;
    finalScore += weighted;
    sum += score;
    count += 1;
    perSeat.push({ agentId: vote.agentId, score, weight, weighted });
  }

  return {
    finalScore,
    meanScore: count > 0 ? sum / count : 0,
    voteCount: count,
    perSeat,
  };
}

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return MIN_SCORE;
  return Math.min(MAX_SCORE, Math.max(MIN_SCORE, Math.round(score)));
}

// ---------------------------------------------------------------------------
// Tie-break, section 12.3
// ---------------------------------------------------------------------------

export interface TieBreakCandidate {
  proposalId: string;
  finalScore: number;
  meanScore: number;
  /** Score the Contrarian seat gave it, if that seat exists and voted. */
  contrarianScore: number | null;
  /** Score the Me Agent gave it, if that seat exists and voted. */
  meScore: number | null;
  createdAt: number;
}

/**
 * Strictly ordered comparison. Negative means `a` wins.
 * Rule 5 guarantees totality, so this is a valid sort comparator.
 */
export function compareByTieBreak(a: TieBreakCandidate, b: TieBreakCandidate): number {
  // 1. Me Agent alone.
  const aMe = a.meScore ?? -Infinity;
  const bMe = b.meScore ?? -Infinity;
  if (aMe !== bMe) return bMe - aMe;

  // 2. Unweighted mean across all enabled seats.
  if (a.meanScore !== b.meanScore) return b.meanScore - a.meanScore;

  // 3. The Contrarian's score: surviving the harshest seat is a real signal.
  const aC = a.contrarianScore ?? -Infinity;
  const bC = b.contrarianScore ?? -Infinity;
  if (aC !== bC) return bC - aC;

  // 4. Earlier idea wins.
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;

  // 5. Total by construction.
  return a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0;
}

/** Rank candidates best-first using the tie-break chain. */
export function rankProposals<T extends TieBreakCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort(compareByTieBreak);
}

// ---------------------------------------------------------------------------
// Dissent, section 12.4
// ---------------------------------------------------------------------------

export interface DissentInput {
  agentId: string;
  score: number;
}

/**
 * An agent dissents on a proposal when its score is at or below
 * `mean(scores) - 2`, or when it scored the winning proposal below 5.
 */
export function isDissenter(
  vote: DissentInput,
  allVotes: readonly DissentInput[],
  isWinningProposal: boolean,
): boolean {
  if (allVotes.length === 0) return false;
  const mean = allVotes.reduce((s, v) => s + v.score, 0) / allVotes.length;
  if (vote.score <= mean - DISSENT_MEAN_MARGIN) return true;
  if (isWinningProposal && vote.score < DISSENT_WINNER_FLOOR) return true;
  return false;
}

export function collectDissent(
  votes: readonly DissentInput[],
  isWinningProposal: boolean,
): DissentInput[] {
  return votes.filter((v) => isDissenter(v, votes, isWinningProposal));
}

// ---------------------------------------------------------------------------
// Derived metrics, section 12.5
// ---------------------------------------------------------------------------

/** Jaccard similarity over token sets, used by the `distinctness` metric. */
export function jaccard(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'for', 'of', 'to', 'in', 'on', 'with', 'that', 'this',
  'is', 'it', 'as', 'by', 'at', 'or', 'be', 'are', 'from', 'into', 'your', 'you',
]);

export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

/** Mean pairwise Jaccard similarity over proposal title + description. */
export function distinctness(docs: readonly { title: string; description: string }[]): number {
  if (docs.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      sum += jaccard(`${docs[i].title} ${docs[i].description}`, `${docs[j].title} ${docs[j].description}`);
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : sum / pairs;
}

/**
 * Resolve an LLM-supplied proposal title to a proposal id.
 * Normalised match, section A.2: case- and punctuation-insensitive.
 */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchProposalByTitle<T extends { id: string; title: string }>(
  proposals: readonly T[],
  targetTitle: string,
): T | null {
  const wanted = normaliseTitle(targetTitle);
  if (!wanted) return null;

  const exact = proposals.find((p) => normaliseTitle(p.title) === wanted);
  if (exact) return exact;

  // Fall back to containment, then to the closest token overlap. The spec asks
  // for a normalised match and the engine drops what it cannot resolve, so a
  // near-miss is worth one more attempt before giving up.
  const contained = proposals.filter((p) => {
    const n = normaliseTitle(p.title);
    return n.includes(wanted) || wanted.includes(n);
  });
  if (contained.length === 1) return contained[0];

  let best: T | null = null;
  let bestScore = 0;
  for (const p of proposals) {
    const score = jaccard(p.title, targetTitle);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 0.5 ? best : null;
}
