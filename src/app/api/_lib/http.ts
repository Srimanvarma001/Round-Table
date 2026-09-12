import 'server-only';

import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { z, type ZodType } from 'zod';

import { collectDissent, distinctness, normaliseWeights, rankProposals, scoreProposal } from '@/lib/agents/weights';
import { config } from '@/lib/config';
import { getDb } from '@/lib/db/client';
import { listAgents } from '@/lib/db/queries/agents';
import { listCritiques, listProposals, listVotes } from '@/lib/db/queries/artifacts';
import {
  runEvents,
  type AgentRow,
  type CritiqueRow,
  type ProfileItemRow,
  type ProfileRow,
  type ProposalRow,
  type RunRow,
  type VoteRow,
} from '@/lib/db/schema';
import { BudgetGuard, budgetLimitsFrom } from '@/lib/orchestrator/budget';
import { getRunEventBus } from '@/lib/orchestrator/bus';
import { buildScoreboard, loadRunContext, type ScoreboardRow } from '@/lib/orchestrator/context';
import type { DissentRow, RunMetrics, RunSummary } from '@/shared/events';
import type { RunStatus } from '@/shared/constants';
import type {
  AgentDTO,
  AgentSnapshotEntry,
  CritiqueDTO,
  ProfileDTO,
  ProfileItemDTO,
  ProposalDTO,
  ProposalScoreDTO,
  RunCompareResponse,
  RunDetailResponse,
  VoteDTO,
} from '@/shared/types';

/**
 * Shared HTTP plumbing for every route handler: the `{ error: { code, message
 * } }` envelope, Zod body parsing, and the row-to-DTO mappers (section 7.13 /
 * 15: raw rows never cross the HTTP boundary).
 */

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function fail(code: string, message: string, status = 400): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** Parse a JSON body against a schema; an empty body reads as `{}`. */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  let raw: unknown = null;
  try {
    const text = await request.text();
    raw = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    return { ok: false, response: fail('INVALID_BODY', 'The request body is not valid JSON.') };
  }

  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at "${issue.path.join('.')}"` : '';
    return {
      ok: false,
      response: fail(
        'INVALID_BODY',
        `The request body is invalid${where}: ${issue?.message ?? 'validation failed'}`,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

/** Every table is single-user in v1 (section 2); the id comes from the env. */
export function currentUserId(): string {
  return config.APP_USER_ID;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function toAgentDTO(row: AgentRow): AgentDTO {
  return {
    id: row.id,
    seatKey: row.seatKey,
    name: row.name,
    isMeAgent: row.isMeAgent,
    lensPrompt: row.lensPrompt,
    provider: row.provider,
    modelId: row.modelId,
    temperature: row.temperature,
    weight: row.weight,
    avatarStyle: row.avatarStyle,
    avatarSeed: row.avatarSeed,
    avatarSvg: row.avatarSvgCache,
    accentColor: row.accentColor,
    accentToken: row.accentToken,
    iconName: row.iconName,
    enabled: row.enabled,
    orderIndex: row.orderIndex,
  };
}

/** Snapshot the enabled seats exactly as the run will freeze them (section 7.5). */
export function buildAgentSnapshot(): {
  snapshot: AgentSnapshotEntry[];
  normalisedWeights: Record<string, number>;
} {
  const db = getDb();
  const rows = listAgents(db);
  const normalised = normaliseWeights(
    rows.map((row) => ({ id: row.id, weight: row.weight, enabled: row.enabled })),
  );

  const snapshot: AgentSnapshotEntry[] = rows
    .filter((row) => row.enabled)
    .map((row) => ({
      id: row.id,
      seatKey: row.seatKey,
      name: row.name,
      isMeAgent: row.isMeAgent,
      lensPrompt: row.lensPrompt,
      provider: row.provider,
      modelId: row.modelId,
      temperature: row.temperature,
      rawWeight: row.weight,
      normalisedWeight: normalised[row.id] ?? 0,
      accentColor: row.accentColor,
      accentToken: row.accentToken,
      orderIndex: row.orderIndex,
      enabled: row.enabled,
    }));

  return { snapshot, normalisedWeights: normalised };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * The winning proposal of a finished run, recomputed from stored rows with the
 * same `weights.ts` implementation the live run used (section 15.2: one
 * implementation of the math). Returns null for a run with no votes.
 */
export function winnerOfRun(run: RunRow): { title: string; finalScore: number } | null {
  const db = getDb();
  const snapshot = (run.agentSnapshot ?? []) as AgentSnapshotEntry[];
  if (snapshot.length === 0) return null;

  const normalised = normaliseWeights(
    snapshot.map((seat) => ({ id: seat.id, weight: seat.rawWeight, enabled: seat.enabled })),
  );
  const proposals = listProposals(db, run.id).filter((p) => p.status === 'active');
  if (proposals.length === 0) return null;

  const votes = listVotes(db, run.id);
  const candidates = proposals.map((proposal) => {
    const breakdown = scoreProposal(
      votes.filter((v) => v.proposalId === proposal.id),
      normalised,
    );
    const me = snapshot.find((s) => s.isMeAgent);
    const contrarian = snapshot.find((s) => s.seatKey === 'seat_contrarian');
    return {
      proposalId: proposal.id,
      title: proposal.title,
      description: proposal.description,
      finalScore: breakdown.finalScore,
      meanScore: breakdown.meanScore,
      voteCount: breakdown.voteCount,
      contrarianScore: contrarian
        ? votes.find((v) => v.proposalId === proposal.id && v.agentId === contrarian.id)?.score ?? null
        : null,
      meScore: me
        ? votes.find((v) => v.proposalId === proposal.id && v.agentId === me.id)?.score ?? null
        : null,
      createdAt: proposal.createdAt,
    };
  });

  const winner = rankProposals(candidates.filter((c) => c.voteCount > 0))[0];
  return winner ? { title: winner.title, finalScore: winner.finalScore } : null;
}

export function toRunSummary(row: RunRow): RunSummary {
  // Winner recomputation only matters for a run that finished; pending runs
  // have no votes to score anyway.
  let winnerTitle: string | null = null;
  let winnerScore: number | null = null;
  if (row.status === 'completed') {
    try {
      const winner = winnerOfRun(row);
      if (winner) {
        winnerTitle = winner.title;
        winnerScore = winner.finalScore;
      }
    } catch {
      // A summary must never fail because derived numbers could not be built.
    }
  }

  return {
    id: row.id,
    seedPrompt: row.seedPrompt,
    status: row.status,
    currentStep: row.currentStep,
    winnerTitle,
    winnerScore,
    costEstimateUsd: row.costEstimateUsd,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    durationMs: row.startedAt && row.completedAt ? row.completedAt - row.startedAt : null,
  };
}

export function toProposalDTO(row: ProposalRow, agentName: string, accentToken: string): ProposalDTO {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName,
    accentToken,
    round: row.round,
    title: row.title,
    description: row.description,
    rationale: row.rationale,
    feasibilityWeeks: row.feasibilityWeeks,
    parentProposalId: row.parentProposalId,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export function toCritiqueDTO(row: CritiqueRow, agentName: string, accentToken: string): CritiqueDTO {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName,
    accentToken,
    targetProposalId: row.targetProposalId,
    stance: row.stance,
    comment: row.comment,
    round: row.round,
  };
}

export function toVoteDTO(row: VoteRow, agentName: string, accentToken: string): VoteDTO {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName,
    accentToken,
    proposalId: row.proposalId,
    score: row.score,
    weightAtVote: row.weightAtVote,
    weightedScore: row.weightedScore,
    comment: row.comment,
  };
}

export function scoreboardToScores(board: ScoreboardRow[]): ProposalScoreDTO[] {
  return board.map((row) => ({
    proposalId: row.proposalId,
    title: row.title,
    finalScore: row.finalScore,
    meanScore: row.meanScore,
    voteCount: row.voteCount,
    leadAccent: row.leadAccent,
    perSeat: row.perSeat.map((seat) => ({
      agentId: seat.agentId,
      seatName: seat.seatName,
      accentToken: seat.accentToken,
      score: seat.score,
      weighted: seat.weighted,
    })),
  }));
}

/** Dissent rows for the winner, in the reveal card's shape (section 12.4). */
export function winnerDissentDTO(board: ScoreboardRow[]): DissentRow[] {
  const winner = board[0];
  if (!winner) return [];
  const votes = winner.perSeat.map((s) => ({ agentId: s.agentId, score: s.score }));
  const dissenters = new Set(collectDissent(votes, true).map((v) => v.agentId));
  return winner.perSeat
    .filter((seat) => dissenters.has(seat.agentId))
    .map((seat) => ({
      agentId: seat.agentId,
      seatName: seat.seatName,
      accentToken: seat.accentToken,
      score: seat.score,
      comment: seat.comment,
    }));
}

/**
 * The full run snapshot, shared by the detail route, the compare route and the
 * export route. `withEvents` adds the stored event log for replay (§18.2).
 *
 * The context load uses a budget guard with the environment defaults; the
 * detail view never dispatches calls, so the guard is only there to satisfy
 * the context's constructor and its limits are irrelevant here.
 */
export function buildRunDetail(run: RunRow, withEvents = false): RunDetailResponse {
  const db = getDb();
  const limits = budgetLimitsFrom();
  const loaded = loadRunContext(run.id, getRunEventBus(), new BudgetGuard(limits));
  if (!loaded) {
    // The run row exists, so this is a malformed snapshot — the honest answer
    // is an error the route surfaces, not an empty shell of a detail page.
    throw new Error(`Run ${run.id} has no loadable context; its snapshot is unusable.`);
  }
  const ctx = loaded;

  const agentRows = listAgents(db);
  const agentsById = new Map(agentRows.map((row) => [row.id, row] as const));
  const snapshot = (run.agentSnapshot ?? []) as AgentSnapshotEntry[];

  const nameOf = (agentId: string): string => {
    const seat = snapshot.find((s) => s.id === agentId);
    if (seat) return seat.name;
    return agentsById.get(agentId)?.name ?? agentId.slice(0, 8);
  };
  const accentOf = (agentId: string): string => {
    const seat = snapshot.find((s) => s.id === agentId);
    if (seat) return seat.accentToken;
    return agentsById.get(agentId)?.accentToken ?? '--seat-1';
  };

  const proposals = ctx.proposals;
  const critiques = ctx.critiques;
  const votes = ctx.votes;

  const board = buildScoreboard(ctx);
  const active = proposals.filter((p) => p.status === 'active');

  const metrics: RunMetrics = {
    winnerScore: board[0]?.finalScore ?? 0,
    scoreSpread:
      board.length > 0
        ? Math.max(...board.map((r) => r.finalScore)) - Math.min(...board.map((r) => r.finalScore))
        : 0,
    meAlignment: meAlignmentOf(board, snapshot),
    dissentCount: winnerDissentDTO(board).length,
    distinctness: distinctness(active),
    totalCostUsd: run.costEstimateUsd,
    failedSeats: [...new Set(ctx.failedSeats.map((f) => f.seatName))],
  };

  const detail: RunDetailResponse = {
    run: {
      id: run.id,
      seedPrompt: run.seedPrompt,
      seedMode: run.seedMode,
      status: run.status,
      currentStep: run.currentStep,
      stepIndex: run.stepIndex,
      round: run.round,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      costEstimateUsd: run.costEstimateUsd,
      llmCalls: run.llmCalls,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      profileId: run.profileId,
      agentSnapshot: snapshot,
    },
    agents: agentRows.map(toAgentDTO),
    proposals: proposals.map((row) => toProposalDTO(row, nameOf(row.agentId), accentOf(row.agentId))),
    critiques: critiques.map((row) => toCritiqueDTO(row, nameOf(row.agentId), accentOf(row.agentId))),
    votes: votes.map((row) => toVoteDTO(row, nameOf(row.agentId), accentOf(row.agentId))),
    scores: scoreboardToScores(board),
    metrics,
    reveal: ctx.reveal,
    dissent: winnerDissentDTO(board),
    partialScores: board.map((row) => ({
      proposalId: row.proposalId,
      title: row.title,
      weightedScore: row.finalScore,
      votesCast: row.voteCount,
      leadAccent: row.leadAccent,
    })),
    failedSeats: ctx.failedSeats.map((f) => ({
      agentId: f.agentId,
      seatName: f.seatName,
      code: f.code,
      message: f.message,
    })),
  };

  if (withEvents) {
    const rows = db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(asc(runEvents.seq), asc(runEvents.id))
      .all();
    detail.events = rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      type: row.type,
      agentId: row.agentId,
      step: row.step,
      payload: row.payload,
      createdAt: row.createdAt,
    }));
  }

  return detail;
}

function meAlignmentOf(board: ScoreboardRow[], snapshot: AgentSnapshotEntry[]): boolean {
  const winner = board[0];
  const me = snapshot.find((s) => s.isMeAgent);
  if (!winner || !me) return false;
  const vote = winner.perSeat.find((s) => s.agentId === me.id);
  return vote ? vote.score >= 5 : false;
}

export function buildRunCompare(a: RunRow, b: RunRow): RunCompareResponse {
  const detailA = buildRunDetail(a);
  const detailB = buildRunDetail(b);

  const metric = (
    label: string,
    va: number | boolean | string | null,
    vb: number | boolean | string | null,
  ) => ({
    metric: label,
    a: va,
    b: vb,
    delta: typeof va === 'number' && typeof vb === 'number' ? vb - va : null,
  });

  const deltas = [
    metric('winnerScore', detailA.metrics?.winnerScore ?? null, detailB.metrics?.winnerScore ?? null),
    metric('scoreSpread', detailA.metrics?.scoreSpread ?? null, detailB.metrics?.scoreSpread ?? null),
    metric('meAlignment', detailA.metrics?.meAlignment ?? null, detailB.metrics?.meAlignment ?? null),
    metric('dissentCount', detailA.metrics?.dissentCount ?? null, detailB.metrics?.dissentCount ?? null),
    metric('distinctness', detailA.metrics?.distinctness ?? null, detailB.metrics?.distinctness ?? null),
    metric('totalCostUsd', detailA.run.costEstimateUsd, detailB.run.costEstimateUsd),
    metric('proposals', detailA.proposals.length, detailB.proposals.length),
    metric('critiques', detailA.critiques.length, detailB.critiques.length),
    metric('winner', detailA.reveal?.title ?? null, detailB.reveal?.title ?? null),
  ];

  // Section 18.4: the seat diffs explain WHY the numbers moved; the UI renders
  // them above the metric table.
  const seatConfigDiff: RunCompareResponse['seatConfigDiff'] = [];
  const bySeat = new Map<string, { a?: AgentSnapshotEntry; b?: AgentSnapshotEntry }>();
  for (const seat of detailA.run.agentSnapshot) {
    bySeat.set(seat.seatKey, { a: seat, b: bySeat.get(seat.seatKey)?.b });
  }
  for (const seat of detailB.run.agentSnapshot) {
    bySeat.set(seat.seatKey, { a: bySeat.get(seat.seatKey)?.a, b: seat });
  }

  for (const [seatKey, pair] of bySeat) {
    if (!pair.a || !pair.b) {
      seatConfigDiff.push({
        seatKey,
        name: pair.a?.name ?? pair.b?.name ?? seatKey,
        field: 'enabled',
        a: pair.a ? String(pair.a.enabled) : 'absent',
        b: pair.b ? String(pair.b.enabled) : 'absent',
      });
      continue;
    }
    for (const field of ['name', 'provider', 'modelId', 'lensPrompt', 'rawWeight', 'temperature'] as const) {
      const va = String(pair.a[field]);
      const vb = String(pair.b[field]);
      if (va !== vb) {
        seatConfigDiff.push({ seatKey, name: pair.a.name, field, a: va, b: vb });
      }
    }
  }

  return { a: detailA, b: detailB, deltas, seatConfigDiff };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export function toProfileDTO(row: ProfileRow): ProfileDTO {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    summaryText: row.summaryText,
    authorBrief: row.authorBrief,
    generatedAt: row.generatedAt,
    lastManualEditAt: row.lastManualEditAt,
  };
}

export function toProfileItemDTO(row: ProfileItemRow): ProfileItemDTO {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    detail: row.detail,
    source: row.source,
    confidence: row.confidence,
    locked: row.locked,
    stale: row.stale,
    orderIndex: row.orderIndex,
  };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function parseRunStatus(value: string): RunStatus | null {
  const valid: readonly string[] = ['created', 'running', 'paused', 'completed', 'failed', 'aborted'];
  return valid.includes(value) ? (value as RunStatus) : null;
}
