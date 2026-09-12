import 'server-only';

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { GLM_MODEL_ID, ME_AGENT_FINISH_INSTRUCTION, renderSystemContract } from '@/lib/agents/defaults';
import {
  isDissenter,
  normaliseWeights,
  rankProposals,
  scoreProposal,
  type ScoreInput,
} from '@/lib/agents/weights';
import {
  getRun,
  bumpRunUsage,
  setRunStep,
  updateRun,
  type RunConfigSnapshot,
  type RunUpdate,
} from '@/lib/db/queries/runs';
import {
  insertCritique,
  insertProposal,
  listCritiques,
  listProposals,
  listVotes,
  updateProposalStatus,
  upsertVote,
} from '@/lib/db/queries/artifacts';
import { getSettingsOrDefaults } from '@/lib/db/queries/settings';
import { getDb, newId, nowMs } from '@/lib/db/client';
import {
  agentMessages,
  profileItems,
  profiles,
  type CritiqueRow,
  type RunRow,
  type ProposalRow,
  type VoteRow,
} from '@/lib/db/schema';
import type { AgentCallRequest, ChatMessage, LLMDelta } from '@/lib/llm/types';
import { getSearchAdapter, type SearchResult } from '@/lib/search';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRIES,
  MAX_CRITIQUES_PER_AGENT,
  MAX_PROPOSALS_PER_AGENT,
  MAX_REFINE_SEATS,
  PROVIDERS,
  SEAT_KEYS,
  STEP_NAMES,
  type ProviderKey,
  type SeatKey,
  type StepName,
  type StepOrDone,
} from '@/shared/constants';
import type { PartialScore, RevealPayload } from '@/shared/events';
import type { AgentSnapshotEntry, SettingsDTO } from '@/shared/types';

import { renderCritiqueLines, renderDigest, type DigestItem } from './digest';
import { schemaPromptText } from './schemas';
import { SYNTHESIS_AGENT_ID } from './taskKey';
import type { BudgetGuard } from './budget';
import type { DeltaCoalescingBus } from './bus';

/**
 * The prompt context, section 9.1, and the engine's contract with the step
 * modules, section 11.3.
 *
 * Every step module is small on purpose: it decides *which* tasks exist and
 * *what a result means*, and all of the shared machinery — the four prompt
 * layers, the digest budgets, the digests themselves, the seat lookup, the
 * scoreboard and persistence — lives here. Duplicating prompt assembly in five
 * step files is how the five steps drift apart, and section 9.3 is explicit
 * that they must not: "Every seat MUST receive the same step instruction and
 * the same output schema."
 */

// ---------------------------------------------------------------------------
// Step interface, section 11.3
// ---------------------------------------------------------------------------

export function isStepName(value: string): value is StepName {
  return (STEP_NAMES as readonly string[]).includes(value);
}

/** The step order, section 11.2. `refine` is conditionally skipped. */
export const STEP_ORDER: readonly StepName[] = STEP_NAMES;

export function stepIndex(step: StepOrDone): number {
  if (step === 'done') return STEP_ORDER.length;
  return STEP_ORDER.indexOf(step);
}

/**
 * `propose -> debate -> refine -> vote -> reveal -> done`, skipping refine
 * when the run was configured without it (section 11.2).
 */
export function nextStep(step: StepName, refineEnabled: boolean): StepOrDone {
  const index = STEP_ORDER.indexOf(step);
  let next = STEP_ORDER[index + 1];
  if (next === 'refine' && !refineEnabled) next = 'vote';
  return next ?? 'done';
}

/** The steps a run will actually walk, for the `run.started` payload. */
export function plannedSteps(refineEnabled: boolean): StepName[] {
  return STEP_ORDER.filter((step) => step !== 'refine' || refineEnabled);
}

/** What the LLM returned for one task, plus the validated payload (A.1–A.5). */
export interface StepResult {
  /** Output of `parseStructured` against the step's Appendix A schema. */
  parsed: unknown;
  contentText: string;
  reasoningText: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string;
  latencyMs: number;
  /** 1 when the first attempt validated, 2 when a repair retry did (17.4). */
  attempts: number;
}

/**
 * Section 11.3, verbatim, plus two additions the engine needs and the spec's
 * sketch does not name:
 *
 *  - `schema` — the Appendix A schema the scheduler validates against. The
 *    spec puts validation in `lib/llm/json.ts` but leaves the wiring implicit.
 *  - `enrichDone` — the section 16.7 partial vote scores, which the spec
 *    requires on the `agent.done` payload for the vote step only.
 */
export interface StepTask {
  step: StepName;
  agentId: string;
  taskKey: string;
  /** Appendix A schema for this step, validated after the call. */
  schema: z.ZodType;
  buildRequest(ctx: RunContext): AgentCallRequest;
  applyResult(ctx: RunContext, result: StepResult): Promise<void>;
  onDelta(delta: LLMDelta): void;
  /**
   * `false` routes the task through `adapter.complete()` for the provider's
   * real token usage instead of the streamed character estimate. Used only by
   * the reveal synthesis, the one call with no seat to animate (section 11.3).
   */
  stream?: boolean;
  /** Extra `agent.done` payload for this task (section 16.7). */
  enrichDone?(ctx: RunContext): { partialScores?: PartialScore[] };
}

/**
 * The failure fields a settled task reports, shared by the scheduler's
 * `TaskFailure`, the engine's `FailedSeat` rows and the `agent.failed` payload.
 */
export interface StepTaskFailureData {
  code: string;
  message: string;
  retryable: boolean;
}

/** Section 11.3, verbatim, plus an optional `shouldSkip` (see below). */
export interface StepModule {
  name: StepName;
  buildTasks(ctx: RunContext): StepTask[];
  onStepComplete(ctx: RunContext): Promise<void>;
  isComplete(ctx: RunContext): boolean;
  /**
   * Not in the section 11.3 sketch: section 11.2 requires `refine` to be
   * skipped "when no proposal received a critique", which is a property of the
   * step rather than of its task list. Returning `true` advances the step with
   * no `step.started` event at all, so the timeline never shows a step that
   * did not happen.
   */
  shouldSkip?(ctx: RunContext): boolean;
}

// ---------------------------------------------------------------------------
// Run settings
// ---------------------------------------------------------------------------

export interface RunSettings {
  /** Frozen per run, from `runs.config_snapshot` (section 17.2). */
  budgetUsd: number;
  maxTokens: number;
  maxCalls: number;
  refineEnabled: boolean;
  searchEnabled: boolean;
  staggerCadenceMs: number;
  /** Operational knobs, live from the settings table (section 17.1). */
  maxCritiquesPerAgent: number;
  maxTokensByStep: Record<StepName, number>;
  requestTimeoutMs: number;
  retries: number;
  concurrency: number;
  temperatureBySeatClass: { me: number; lens: number };
  reasoningPanelEnabled: boolean;
  /** The one non-agent call (section 11.3). Defaults per PROVIDER-NOTES 1. */
  synthesis: { provider: ProviderKey; modelId: string };
  /** Reflection cap, section 11.3. */
  maxRefineSeats: number;
  /** Section 9.3 caps. */
  maxProposalsPerAgent: number;
}

/**
 * OWNER CHANGE, 2026-09-11: DeepSeek was removed, so the synthesis runs on the
 * same GLM model as every seat. Configurable per run through
 * `config_snapshot.synthesis` if a second provider returns.
 */
const DEFAULT_SYNTHESIS = {
  provider: 'glm' as ProviderKey,
  modelId: GLM_MODEL_ID,
};

/**
 * `config_snapshot` as written by `POST /api/runs` (`RunConfigSnapshot` in
 * `lib/db/queries/runs.ts`) plus the optional keys the orchestrator
 * understands. Every field is optional and the whole object falls back to
 * `{}`, so a run created by an older build — or by a caller that only filled
 * in the four documented fields — still runs on defaults rather than failing
 * to start.
 */
const ConfigSnapshotSchema = z
  .object({
    budgetUsd: z.number().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCalls: z.number().int().positive().optional(),
    refineEnabled: z.boolean().optional(),
    searchEnabled: z.boolean().optional(),
    staggerCadenceMs: z.number().int().nonnegative().optional(),
    maxCritiquesPerAgent: z.number().int().min(1).max(MAX_CRITIQUES_PER_AGENT).optional(),
    maxProposalsPerAgent: z.number().int().min(1).max(MAX_PROPOSALS_PER_AGENT).optional(),
    maxRefineSeats: z.number().int().min(1).max(16).optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    retries: z.number().int().min(0).max(5).optional(),
    concurrency: z.number().int().min(1).max(32).optional(),
    reasoningPanelEnabled: z.boolean().optional(),
    temperatureBySeatClass: z.object({ me: z.number(), lens: z.number() }).optional(),
    synthesis: z
      .object({ provider: z.enum(PROVIDERS), modelId: z.string().min(1) })
      .optional(),
    maxTokensByStep: z.record(z.string(), z.number().int().positive()).optional(),
  })
  .catch({});

export type RunConfigSnapshotInput = z.infer<typeof ConfigSnapshotSchema>;

/**
 * Layer the run's frozen snapshot over the live settings: budgets and
 * `refineEnabled` are frozen at run start (section 7.5), while retries,
 * concurrency and the timeout are operational knobs that may be tuned between
 * runs and should apply to the next call (section 17.1).
 */
export function loadRunSettings(
  configSnapshot: unknown,
  stored: SettingsDTO,
): RunSettings {
  const snapshot = ConfigSnapshotSchema.parse(configSnapshot ?? {});

  const maxTokensByStep: Record<StepName, number> = { ...DEFAULT_MAX_TOKENS };
  for (const step of STEP_NAMES) {
    const override = snapshot.maxTokensByStep?.[step];
    if (typeof override === 'number' && override > 0) maxTokensByStep[step] = override;
  }

  return {
    budgetUsd: snapshot.budgetUsd ?? stored.budgetUsd,
    maxTokens: snapshot.maxTokens ?? stored.maxTokens,
    maxCalls: snapshot.maxCalls ?? stored.maxCalls,
    refineEnabled: snapshot.refineEnabled ?? stored.refineEnabled,
    searchEnabled: snapshot.searchEnabled ?? true,
    staggerCadenceMs: snapshot.staggerCadenceMs ?? stored.staggerCadenceMs,
    maxCritiquesPerAgent:
      snapshot.maxCritiquesPerAgent ?? stored.maxCritiquesPerAgent ?? MAX_CRITIQUES_PER_AGENT,
    maxTokensByStep,
    requestTimeoutMs: snapshot.requestTimeoutMs ?? stored.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    retries: snapshot.retries ?? stored.retries ?? DEFAULT_RETRIES,
    concurrency: snapshot.concurrency ?? stored.concurrency ?? DEFAULT_CONCURRENCY,
    temperatureBySeatClass: snapshot.temperatureBySeatClass ?? stored.temperatureBySeatClass,
    reasoningPanelEnabled: snapshot.reasoningPanelEnabled ?? stored.reasoningPanelEnabled,
    synthesis: snapshot.synthesis ?? DEFAULT_SYNTHESIS,
    maxRefineSeats: snapshot.maxRefineSeats ?? MAX_REFINE_SEATS,
    maxProposalsPerAgent: snapshot.maxProposalsPerAgent ?? MAX_PROPOSALS_PER_AGENT,
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface RunProfile {
  id: string | null;
  /** Section 10.5 `summary_text` — the Me Agent's full profile. */
  summaryText: string;
  /** Section 10.5 `author_brief` — the short brief every seat receives. */
  authorBrief: string;
  /** Cited explicitly by the Me Agent's finish instruction (section 9.2). */
  constraints: string[];
  antiPatterns: string[];
}

const EMPTY_PROFILE: RunProfile = {
  id: null,
  summaryText: '',
  authorBrief: '',
  constraints: [],
  antiPatterns: [],
};

function loadProfile(run: RunRow): RunProfile {
  const db = getDb();
  try {
    const profile = run.profileId
      ? db.select().from(profiles).where(eq(profiles.id, run.profileId)).get()
      : db
          .select()
          .from(profiles)
          .where(eq(profiles.status, 'active'))
          .orderBy(profiles.version)
          .limit(1)
          .get();

    if (!profile) return EMPTY_PROFILE;

    const items = db
      .select()
      .from(profileItems)
      .where(eq(profileItems.profileId, profile.id))
      .all();

    const visible = items.filter((item) => !item.stale);

    return {
      id: profile.id,
      summaryText: profile.summaryText,
      authorBrief: profile.authorBrief,
      constraints: visible
        .filter((item) => item.kind === 'constraint')
        .map((item) => item.label),
      antiPatterns: visible
        .filter((item) => item.kind === 'anti_pattern')
        .map((item) => item.label),
    };
  } catch {
    // A profile is an enhancement, never a prerequisite: a run with no profile
    // still produces ideas, it just loses the Me Agent's grounding.
    return EMPTY_PROFILE;
  }
}

// ---------------------------------------------------------------------------
// Persistence — the engine owns it (section 11.3)
// ---------------------------------------------------------------------------

export interface UsageDelta {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  calls: number;
}

/** A message row as the engine writes it, so a step never touches SQL. */
export interface MessageRecord {
  agentId: string;
  step: StepName;
  taskKey: string;
  requestJson: unknown;
  reasoningText: string;
  contentText: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  finishReason: string;
  error: string | null;
}

/**
 * Everything a step module is allowed to write. Injected as `ctx.persist`.
 *
 * Section 11.3 says "the engine owns all persistence". This interface is how
 * that is made true rather than aspirational: a step module has no database
 * handle and no import of `lib/db`, it has this capability, and every method
 * on it belongs to the engine.
 */
export interface RunPersistence {
  insertProposal(input: {
    agentId: string;
    round: number;
    title: string;
    description: string;
    rationale: string;
    feasibilityWeeks: number | null;
    parentProposalId: string | null;
  }): ProposalRow;
  setProposalStatus(proposalId: string, status: 'active' | 'merged' | 'eliminated'): void;
  insertCritique(input: {
    agentId: string;
    targetProposalId: string;
    stance: string;
    comment: string;
    round: number;
  }): CritiqueRow;
  /** Retry-safe: re-applying the same vote updates rather than conflicts. */
  upsertVote(input: {
    agentId: string;
    proposalId: string;
    score: number;
    weightAtVote: number;
    weightedScore: number;
    comment: string;
  }): VoteRow;
  /** Append-only ledger of LLM calls (section 7.10). */
  insertMessage(record: MessageRecord): boolean;
  /** Task keys already present in `agent_messages` — the resume filter (11.4). */
  existingTaskKeys(): Set<string>;
  /** Re-read the run's artefacts into the context. */
  reload(): void;
  setStep(step: StepOrDone): void;
  setRound(round: number): void;
  patchRun(patch: RunUpdate): void;
  /** Accumulate usage in SQL and mirror it into `ctx.usage`. */
  bumpUsage(delta: UsageDelta): void;
}

/** Running totals, seeded from the `runs` row so a resume cannot respend. */
export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  calls: number;
}

// ---------------------------------------------------------------------------
// RunContext
// ---------------------------------------------------------------------------

export interface RunContext {
  readonly runId: string;
  /** The freshest `runs` row the engine has; replaced on every reload. */
  run: RunRow;
  readonly settings: RunSettings;
  readonly snapshot: AgentSnapshotEntry[];
  readonly normalisedWeights: Record<string, number>;
  readonly profile: RunProfile;
  readonly bus: DeltaCoalescingBus;
  readonly budget: BudgetGuard;
  readonly usage: RunUsage;
  readonly scratch: RunScratch;
  /** Non-fatal problems, surfaced on `step.completed` and in the export. */
  readonly warnings: string[];
  /** Seats whose task ended in a recorded failure (section 17.3, 17.5). */
  readonly failedSeats: FailedSeat[];
  proposals: ProposalRow[];
  critiques: CritiqueRow[];
  votes: VoteRow[];
  /** Set by the reveal step; the winner card (section A.5). */
  reveal: RevealPayload | null;
  /** Trend-Watcher search hits, keyed by agent id (sections 9.2 and 10.1). */
  readonly search: Map<string, SearchResult[]>;
  /** Injected by the engine immediately after construction. */
  persist: RunPersistence;
}

export interface FailedSeat {
  agentId: string;
  seatName: string;
  step: StepName;
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * The "scratch area" the brief asks for: a bag for values that only need to
 * live for one step, plus per-task cells the engine clears when a task settles
 * so a long run cannot grow without bound.
 */
export class RunScratch {
  private readonly values = new Map<string, unknown>();

  private readonly tasks = new Map<string, Map<string, unknown>>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.values.set(key, value);
  }

  getForTask<T>(taskKey: string, key: string): T | undefined {
    return this.tasks.get(taskKey)?.get(key) as T | undefined;
  }

  setForTask<T>(taskKey: string, key: string, value: T): void {
    let bag = this.tasks.get(taskKey);
    if (!bag) {
      bag = new Map();
      this.tasks.set(taskKey, bag);
    }
    bag.set(key, value);
  }

  clearTask(taskKey: string): void {
    this.tasks.delete(taskKey);
  }
}

// ---------------------------------------------------------------------------
// Seat helpers
// ---------------------------------------------------------------------------

export function enabledSeats(ctx: RunContext): AgentSnapshotEntry[] {
  return ctx.snapshot
    .filter((seat) => seat.enabled)
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export function agentById(ctx: RunContext, agentId: string): AgentSnapshotEntry | undefined {
  return ctx.snapshot.find((seat) => seat.id === agentId);
}

export function seatNameFor(ctx: RunContext, agentId: string): string {
  if (agentId === SYNTHESIS_AGENT_ID) return 'Synthesis';
  return agentById(ctx, agentId)?.name ?? agentId.slice(0, 8);
}

export function meAgent(ctx: RunContext): AgentSnapshotEntry | undefined {
  return ctx.snapshot.find((seat) => seat.isMeAgent);
}

/**
 * The two stable seat keys the orchestrator reasons about by name. The rest of
 * the code works off the snapshot and never cares which seat it is.
 */
export const CONTRARIAN_SEAT_KEY: SeatKey = 'seat_contrarian';
export const TREND_WATCHER_SEAT_KEY: SeatKey = 'seat_trend_watcher';

export function contrarianAgent(ctx: RunContext): AgentSnapshotEntry | undefined {
  return ctx.snapshot.find((seat) => seat.seatKey === CONTRARIAN_SEAT_KEY);
}

export function activeProposals(ctx: RunContext): ProposalRow[] {
  return ctx.proposals.filter((proposal) => proposal.status === 'active');
}

export function critiquesFor(ctx: RunContext, proposalId: string): CritiqueRow[] {
  return ctx.critiques.filter((critique) => critique.targetProposalId === proposalId);
}

export function votesFor(ctx: RunContext, proposalId: string): VoteRow[] {
  return ctx.votes.filter((vote) => vote.proposalId === proposalId);
}

/**
 * The synthesis seat: not a real `agents` row, because it never speaks in the
 * ring and never votes. It exists so the reveal call can travel the exact same
 * `buildAgentRequest` path as every other call (section 9.3: format drift is
 * the enemy), with the sections 8.4 / PROVIDER-NOTES 1 assignment.
 */
export function synthesisSeat(ctx: RunContext): AgentSnapshotEntry {
  return {
    id: SYNTHESIS_AGENT_ID,
    seatKey: 'seat_synthesis',
    name: 'Synthesis',
    isMeAgent: false,
    lensPrompt:
      'You are the run\'s synthesiser, not a participant. You did not propose, critique or vote. ' +
      'You read the table\'s output and write the single buildable plan it converged on.',
    provider: ctx.settings.synthesis.provider,
    modelId: ctx.settings.synthesis.modelId,
    temperature: 0.4,
    rawWeight: 0,
    normalisedWeight: 0,
    accentColor: '#E5E7EB',
    accentToken: '--seat-1',
    orderIndex: SEAT_KEYS.length,
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// Scoreboard (sections 12.2, 12.3, 12.5, 16.7)
// ---------------------------------------------------------------------------

export interface ScoreboardRow {
  proposalId: string;
  title: string;
  description: string;
  finalScore: number;
  meanScore: number;
  voteCount: number;
  authorAgentId: string;
  authorName: string;
  leadAccent: string;
  contrarianScore: number | null;
  meScore: number | null;
  createdAt: number;
  /** 0 is the leader. Ordering is the section 12.3 tie-break chain. */
  rank: number;
  perSeat: Array<{
    agentId: string;
    seatName: string;
    accentToken: string;
    score: number;
    weighted: number;
    comment: string;
  }>;
}

/**
 * The single scoring implementation used by the vote plinth (16.7), the reveal
 * prompt (A.5), the deterministic fallback (17.4) and the run metrics (12.5).
 * It is recomputed from stored `votes` rows every time, never cached, exactly
 * as section 12.2 requires.
 */
export function buildScoreboard(ctx: RunContext): ScoreboardRow[] {
  const seats = enabledSeats(ctx);
  const contrarian = contrarianAgent(ctx);
  const me = meAgent(ctx);

  const rows = activeProposals(ctx).map((proposal) => {
    const votes = votesFor(ctx, proposal.id);
    const scoreInputs: ScoreInput[] = votes.map((vote) => ({
      agentId: vote.agentId,
      score: vote.score,
    }));
    const breakdown = scoreProposal(scoreInputs, ctx.normalisedWeights);
    const author = agentById(ctx, proposal.agentId);

    const voteBy = (agentId: string | undefined): number | null => {
      if (!agentId) return null;
      const vote = votes.find((v) => v.agentId === agentId);
      return vote ? vote.score : null;
    };

    return {
      proposalId: proposal.id,
      title: proposal.title,
      description: proposal.description,
      finalScore: breakdown.finalScore,
      meanScore: breakdown.meanScore,
      voteCount: breakdown.voteCount,
      authorAgentId: proposal.agentId,
      authorName: author?.name ?? proposal.agentId.slice(0, 8),
      leadAccent: author?.accentToken ?? '--seat-1',
      contrarianScore: voteBy(contrarian?.id),
      meScore: voteBy(me?.id),
      createdAt: proposal.createdAt,
      rank: 0,
      perSeat: seats.flatMap((seat) => {
        const vote = votes.find((v) => v.agentId === seat.id);
        if (!vote) return [];
        const weight = ctx.normalisedWeights[seat.id] ?? 0;
        return [
          {
            agentId: seat.id,
            seatName: seat.name,
            accentToken: seat.accentToken,
            score: vote.score,
            weighted: vote.weightedScore,
            comment: vote.comment,
          },
        ];
      }),
    };
  });

  const ranked = rankProposals(rows);
  return ranked.map((row, index) => ({ ...row, rank: index }));
}

/** Section 16.7: the incremental plinth payload carried on `agent.done`. */
export function partialScoresFrom(ctx: RunContext): PartialScore[] {
  return buildScoreboard(ctx).map((row) => ({
    proposalId: row.proposalId,
    title: row.title,
    weightedScore: row.finalScore,
    votesCast: row.voteCount,
    leadAccent: row.leadAccent,
  }));
}

// ---------------------------------------------------------------------------
// Prompt assembly, section 9.1
// ---------------------------------------------------------------------------

export interface PromptLayers {
  /** 1. The fixed system contract plus this step's schema and limits. */
  contract: string;
  /** 2. The seat's editable lens. */
  lens: string;
  /** 3. The author snapshot: brief for lenses, full profile for the Me Agent. */
  author: string;
  /** 4. Seed, task and the digests of prior artefacts. */
  task: string;
}

/**
 * Layer 1. Section 9.1: the contract "defines the output format, the JSON
 * schema for the current step, the ban on meta-commentary, and the length
 * limits. Never contains a persona."
 */
export function contractLayer(seat: AgentSnapshotEntry, step: StepName): string {
  return [
    renderSystemContract(seat.name, step),
    '',
    'Output format. Return a single JSON object and nothing else, matching this shape exactly:',
    schemaPromptText(step),
  ].join('\n');
}

/**
 * Layer 3. Section 9.2: the short `author_brief` goes to every seat "so no
 * lens proposes work the user cannot or will not do", and the Me Agent gets
 * the full `summary_text` plus the explicit finish-it instruction instead.
 */
export function authorLayer(ctx: RunContext, seat: AgentSnapshotEntry): string {
  if (seat.isMeAgent) {
    const parts = ['Author profile (full summary):', ctx.profile.summaryText || '(no profile has been generated yet)'];

    if (ctx.profile.constraints.length > 0) {
      parts.push('', `Constraint items: ${ctx.profile.constraints.join('; ')}`);
    }
    if (ctx.profile.antiPatterns.length > 0) {
      parts.push('', `Anti-pattern items: ${ctx.profile.antiPatterns.join('; ')}`);
    }
    parts.push('', ME_AGENT_FINISH_INSTRUCTION);
    return parts.join('\n');
  }

  return [
    'Author snapshot (the person this table is for):',
    ctx.profile.authorBrief || '(no profile brief is available for this run)',
  ].join('\n');
}

/**
 * Layer 4's search block. Section 9.2 and B.8: the Trend-Watcher seat receives
 * live search results; every other seat receives nothing, so no other lens
 * starts citing the outside world.
 */
export function searchLayer(ctx: RunContext, seat: AgentSnapshotEntry): string {
  if (seat.seatKey !== TREND_WATCHER_SEAT_KEY) return '';
  const hits = ctx.search.get(seat.id) ?? [];
  if (hits.length === 0) {
    return 'Live search results: none were available for this run. Say so if it matters, and never invent a source.';
  }
  const lines = hits.map(
    (hit, index) => `${index + 1}. ${hit.title} — ${truncateLine(hit.content, 320)} (${hit.url})`,
  );
  return ['Live search results (cite these; invent nothing beyond them):', ...lines].join('\n');
}

export function buildPromptLayers(
  ctx: RunContext,
  seat: AgentSnapshotEntry,
  step: StepName,
  taskText: string,
): PromptLayers {
  const search = searchLayer(ctx, seat);
  return {
    contract: contractLayer(seat, step),
    lens: seat.lensPrompt || 'You have no lens configured. Speak from the generalist view.',
    author: authorLayer(ctx, seat),
    task: search ? `${taskText}\n\n${search}` : taskText,
  };
}

export function toChatMessages(layers: PromptLayers): ChatMessage[] {
  // Section 9.1: four layers "as separate messages", in order. Keeping them
  // separate rather than concatenated is what lets a provider apply its own
  // system-prompt weighting to the contract without the lens diluting it.
  return [
    { role: 'system', content: layers.contract },
    { role: 'system', content: layers.lens },
    { role: 'system', content: layers.author },
    { role: 'user', content: layers.task },
  ];
}

export function buildAgentRequest(
  ctx: RunContext,
  seat: AgentSnapshotEntry,
  step: StepName,
  taskText: string,
): AgentCallRequest {
  return {
    provider: seat.provider,
    modelId: seat.modelId,
    messages: toChatMessages(buildPromptLayers(ctx, seat, step, taskText)),
    temperature: temperatureFor(ctx, seat),
    maxTokens: ctx.settings.maxTokensByStep[step] ?? DEFAULT_MAX_TOKENS[step],
    jsonMode: true,
    reasoning: reasoningFor(ctx, seat, step),
    label: `${step}:${seat.name}`,
  };
}

function temperatureFor(ctx: RunContext, seat: AgentSnapshotEntry): number {
  if (Number.isFinite(seat.temperature)) return seat.temperature;
  return seat.isMeAgent
    ? ctx.settings.temperatureBySeatClass.me
    : ctx.settings.temperatureBySeatClass.lens;
}

/**
 * Whether to *ask* for the reasoning channel.
 *
 * The assignment in PROVIDER-NOTES section 1 requests reasoning for the Me
 * Agent and the reveal synthesis and not for the lens seats. It is only ever a
 * hint: `openai-compatible.ts` sends no `thinking` block to GLM at all,
 * because glm-5.3-flash cannot stop thinking and rejects the attempt with a
 * 400 (PROVIDER-NOTES section 3).
 */
function reasoningFor(ctx: RunContext, seat: AgentSnapshotEntry, step: StepName): boolean {
  if (!ctx.settings.reasoningPanelEnabled) return false;
  return seat.isMeAgent || step === 'reveal';
}

// ---------------------------------------------------------------------------
// Step instructions, Appendix B.10
// ---------------------------------------------------------------------------

/** Appendix B.10's `{vague | specific}`. */
export function seedLine(ctx: RunContext): string {
  return `Seed: ${ctx.run.seedPrompt}. Seed mode: ${ctx.run.seedMode}.`;
}

/**
 * B.10 propose:
 * `Seed: {seed}. Seed mode: {vague | specific}. Author brief: {brief}.
 *  Propose {1-2} ideas from your lens. Return the propose JSON.`
 */
export function proposeTaskText(ctx: RunContext, seat: AgentSnapshotEntry): string {
  const count = `1-${ctx.settings.maxProposalsPerAgent}`;
  const brief = ctx.profile.authorBrief || '(no profile brief is available for this run)';
  return (
    `${seedLine(ctx)} Author brief: ${brief}. ` +
    `Propose ${count} ideas from your lens. Return the propose JSON.`
  );
}

/**
 * B.10 debate:
 * `Seed: {seed}. Proposals: {numbered list of title and description}.
 *  Pick {2-3} to critique, at least one not your own. Attack what actually
 *  fails, support what works, extend what is half-good. Return the debate JSON.`
 */
export function debateTaskText(ctx: RunContext, seat: AgentSnapshotEntry): string {
  const proposals = activeProposals(ctx);
  const digest = renderDigest(
    proposals.map((proposal, index) => proposalDigestItem(ctx, proposal, index)),
    PROMPT_BUDGETS.debateProposals,
  );
  const max = ctx.settings.maxCritiquesPerAgent;
  const min = Math.min(2, max);
  const pick = min >= max ? `${max}` : `${min}-${max}`;
  return (
    `${seedLine(ctx)} Proposals: ${digest.text}. ` +
    `Pick ${pick} to critique, at least one not your own. ` +
    'Attack what actually fails, support what works, extend what is half-good. ' +
    'Return the debate JSON.'
  );
}

/**
 * B.10 refine:
 * `Your proposal: {title, description}. Critiques it drew: {critiques}.
 *  Revise it if the critiques are right, merge with another proposal if the
 *  merge is stronger, or return null if it should stand. Return the refine JSON.`
 *
 * The merging seat is also shown the other live proposals, which B.10's
 * skeleton does not include: `merges_proposal_titles` (A.3) is unusable
 * without the titles to merge with, and title resolution is a normalised
 * match, so a seat cannot merge into something it was never shown.
 */
export function refineTaskText(ctx: RunContext, base: ProposalRow): string {
  const critiques = renderCritiqueLines(
    critiquesFor(ctx, base.id).map((critique) => ({
      stance: critique.stance,
      seatName: seatNameFor(ctx, critique.agentId),
      comment: critique.comment,
    })),
    PROMPT_BUDGETS.refineCritiques,
  );

  const others = renderDigest(
    activeProposals(ctx)
      .filter((proposal) => proposal.id !== base.id)
      .map((proposal, index) => proposalDigestItem(ctx, proposal, index)),
    PROMPT_BUDGETS.refineOthers,
  );

  const critiqueText = critiques.text || 'none';
  const mergeText = others.text
    ? `\n\nOther live proposals you could merge with:\n${others.text}`
    : '\n\nThere are no other live proposals to merge with.';

  return (
    `Your proposal: ${base.title} — ${base.description}. ` +
    `Critiques it drew: ${critiqueText}. ` +
    'Revise it if the critiques are right, merge with another proposal if the merge is stronger, ' +
    `or return null if it should stand. Return the refine JSON.${mergeText}`
  );
}

/**
 * B.10 vote:
 * `Seed: {seed}. Surviving proposals: {numbered list with digests of their
 *  critiques}. Score each from 1 to 10 from your lens. One sentence of
 *  justification each. Use the full range; do not cluster at 7. Return the
 *  vote JSON.`
 *
 * Section 11.3's token-control requirement: ONE call per agent covering every
 * surviving proposal, never one call per proposal.
 */
export function voteTaskText(ctx: RunContext, seat: AgentSnapshotEntry): string {
  const proposals = activeProposals(ctx);
  const digest = renderDigest(
    proposals.map((proposal, index) => proposalDigestItem(ctx, proposal, index, true)),
    PROMPT_BUDGETS.voteProposals,
  );
  return (
    `${seedLine(ctx)} Surviving proposals: ${digest.text}. ` +
    'Score each from 1 to 10 from your lens. One sentence of justification each. ' +
    'Use the full range; do not cluster at 7. Return the vote JSON.'
  );
}

/**
 * B.10 reveal:
 * `Winning proposal: {proposal}. Score pattern: {per-seat scores}.
 *  Dissent: {dissent rows}. Expand the winner into a buildable plan and ground
 *  the rationale in the vote pattern. Return the reveal JSON.`
 */
export function revealTaskText(ctx: RunContext): string {
  const board = buildScoreboard(ctx);
  const winner = board[0];

  if (!winner) {
    return (
      'No proposal survived to the vote. Return the reveal JSON describing that outcome honestly: ' +
      'title it "No proposal survived", explain in why_it_won that the table failed to converge, ' +
      'give the first step as re-running the table with a narrower seed, and list the failures as risks.'
    );
  }

  const pattern = winner.perSeat
    .map((seat) => `${seat.seatName} ${seat.score}`)
    .join(', ');

  const dissent = renderDissent(winnerDissentRows(ctx, winner));

  return (
    `Winning proposal: ${winner.title} — ${winner.description} ` +
    `(rationale: ${findProposal(ctx, winner.proposalId)?.rationale ?? 'none recorded'}; ` +
    `estimated ${findProposal(ctx, winner.proposalId)?.feasibilityWeeks ?? 'unknown'} weeks). ` +
    `Score pattern: ${pattern || 'no votes were cast'}; ` +
    `weighted ${winner.finalScore.toFixed(3)}, mean ${winner.meanScore.toFixed(2)}. ` +
    `Dissent: ${dissent}. ` +
    'Expand the winner into a buildable plan and ground the rationale in the vote pattern. ' +
    'Return the reveal JSON.'
  );
}

export function findProposal(ctx: RunContext, proposalId: string): ProposalRow | undefined {
  return ctx.proposals.find((proposal) => proposal.id === proposalId);
}

/**
 * Section 12.4, restricted to the winning proposal: this is the dissent list
 * the reveal card renders. The rule itself lives in `lib/agents/weights.ts` so
 * the prompt, the card and the `dissent_count` metric cannot disagree.
 */
export function winnerDissentRows(_ctx: RunContext, winner: ScoreboardRow): ScoreboardRow['perSeat'] {
  const votes = winner.perSeat.map((seat) => ({ agentId: seat.agentId, score: seat.score }));
  return winner.perSeat.filter((seat) =>
    isDissenter({ agentId: seat.agentId, score: seat.score }, votes, true),
  );
}

export function renderDissent(rows: ScoreboardRow['perSeat']): string {
  if (rows.length === 0) return 'none recorded';
  return rows.map((row) => `${row.seatName} ${row.score}: ${row.comment}`).join(' | ');
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/**
 * Token budgets for the layer-4 digests. Deliberately generous enough for a
 * full table of eight seats and small enough that no single step's prompt
 * dominates the run's cost.
 */
export const PROMPT_BUDGETS = {
  debateProposals: 900,
  refineCritiques: 320,
  refineOthers: 260,
  voteProposals: 1200,
} as const;

/** One proposal, as the debate and vote digests render it. */
export function proposalDigestItem(
  ctx: RunContext,
  proposal: ProposalRow,
  index: number,
  withCritiques = false,
): DigestItem {
  const author = agentById(ctx, proposal.agentId);
  const notes: string[] = [];
  if (author) notes.push(`author: ${author.name}`);
  if (proposal.feasibilityWeeks !== null) {
    notes.push(`about ${proposal.feasibilityWeeks} weeks`);
  }
  if (proposal.round > 1) notes.push(`revised (round ${proposal.round})`);

  if (withCritiques) {
    const critiques = critiquesFor(ctx, proposal.id);
    if (critiques.length > 0) {
      const summary = renderCritiqueLines(
        critiques.map((critique) => ({
          stance: critique.stance,
          seatName: seatNameFor(ctx, critique.agentId),
          comment: critique.comment,
        })),
        PROMPT_BUDGETS.refineCritiques,
      );
      if (summary.text) notes.push(`critiques:\n${summary.text}`);
    }
  }

  return {
    id: proposal.id,
    heading: proposal.title,
    body: proposal.description,
    notes,
    // Insertion order: the debate and vote digests are not ranked by score
    // (no votes exist during debate, and the vote prompt must show every
    // survivor in a stable order so a seat's answer is comparable across runs).
    rank: index,
  };
}

/** Non-ASCII-free, deterministic truncation for a search snippet. */
function truncateLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Live search for the Trend-Watcher seat
// ---------------------------------------------------------------------------

/**
 * Populate `ctx.search` for the Trend-Watcher seat, once per step.
 *
 * Sections 10.1 and 9.2: the seat's whole value is the outside world, so the
 * results go into its prompt. Section 17.3's spirit applies to search too —
 * this is best-effort enrichment and MUST never fail the task, so every
 * failure path ends in an empty result set plus a recorded warning.
 */
export async function ensureSearchResults(ctx: RunContext, step: StepName): Promise<void> {
  const seats = enabledSeats(ctx).filter((seat) => seat.seatKey === TREND_WATCHER_SEAT_KEY);
  if (seats.length === 0) return;

  const marker = `search:${step}`;
  if (ctx.scratch.get<boolean>(marker)) return;
  ctx.scratch.set(marker, true);

  if (!ctx.settings.searchEnabled) {
    for (const seat of seats) ctx.search.set(seat.id, []);
    ctx.warnings.push('Search is disabled for this run; the Trend-Watcher seat ran without live results.');
    return;
  }

  let results: SearchResult[] = [];
  try {
    results = await getSearchAdapter().search(searchQuery(ctx));
  } catch (err) {
    ctx.warnings.push(
      `Live search failed (${err instanceof Error ? err.message : String(err)}); ` +
        'the Trend-Watcher seat ran without results.',
    );
    results = [];
  }

  for (const seat of seats) ctx.search.set(seat.id, results);
}

function searchQuery(ctx: RunContext): string {
  const seed = ctx.run.seedPrompt.replace(/\s+/g, ' ').trim();
  return seed.length > 400 ? seed.slice(0, 400) : seed;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Build the context for a run.
 *
 * Returns `null` when the run does not exist. Throws when the run exists but
 * is unusable (no seat snapshot, no enabled seat) — the engine turns that into
 * a recorded `INTERNAL` failure, which is the honest outcome for a run whose
 * configuration cannot produce a table.
 */
export function loadRunContext(
  runId: string,
  bus: DeltaCoalescingBus,
  budget: BudgetGuard,
): RunContext | null {
  const db = getDb();
  const run = getRun(db, runId);
  if (!run) return null;

  const snapshot = parseSnapshot(run.agentSnapshot);
  const stored = getSettingsOrDefaults(db);
  const settings = loadRunSettings(run.configSnapshot, stored);

  const enabled = snapshot.filter((seat) => seat.enabled);
  if (enabled.length === 0) {
    throw new Error(`Run ${runId} has no enabled seats; refusing to start.`);
  }

  const normalisedWeights = normaliseWeights(
    snapshot.map((seat) => ({
      id: seat.id,
      weight: Number.isFinite(seat.rawWeight) ? seat.rawWeight : seat.normalisedWeight,
      enabled: seat.enabled,
    })),
  );

  const ctx: RunContext = {
    runId,
    run,
    settings,
    snapshot,
    normalisedWeights,
    profile: loadProfile(run),
    bus,
    budget,
    usage: {
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      costUsd: run.costEstimateUsd,
      calls: run.llmCalls,
    },
    scratch: new RunScratch(),
    warnings: [],
    failedSeats: [],
    proposals: listProposals(db, runId),
    critiques: listCritiques(db, runId),
    votes: listVotes(db, runId),
    reveal: null,
    search: new Map(),
    // Replaced immediately below; declared non-optional so a step module never
    // has to null-check it.
    persist: undefined as unknown as RunPersistence,
  };

  ctx.persist = createPersistence(ctx);
  return ctx;
}

const SnapshotSeatSchema = z
  .object({
    id: z.string().min(1),
    seatKey: z.string().min(1),
    name: z.string().min(1),
    isMeAgent: z.boolean().catch(false),
    lensPrompt: z.string().catch(''),
    provider: z.enum(PROVIDERS).catch('mock'),
    modelId: z.string().catch(''),
    temperature: z.number().catch(0.7),
    rawWeight: z.number().catch(0),
    normalisedWeight: z.number().catch(0),
    accentColor: z.string().catch('#60A5FA'),
    accentToken: z.string().catch('--seat-1'),
    orderIndex: z.number().catch(0),
    enabled: z.boolean().catch(true),
  })
  .catch({
    id: '',
    seatKey: '',
    name: '',
    isMeAgent: false,
    lensPrompt: '',
    provider: 'mock' as ProviderKey,
    modelId: '',
    temperature: 0.7,
    rawWeight: 0,
    normalisedWeight: 0,
    accentColor: '#60A5FA',
    accentToken: '--seat-1',
    orderIndex: 0,
    enabled: true,
  });

/**
 * A seat snapshot written by an older build may miss a field the orchestrator
 * now reads. Rather than refusing to run a historical run, each entry is
 * coerced and unusable entries are dropped.
 */
function parseSnapshot(raw: unknown): AgentSnapshotEntry[] {
  const result = z.array(SnapshotSeatSchema).safeParse(raw);
  const entries = result.success ? result.data : [];
  const usable = entries.filter((seat) => seat.id.length > 0 && seat.modelId.length > 0);

  const enabled = usable.filter((seat) => seat.enabled);
  if (enabled.length === 0) {
    throw new Error('The run has no usable seats: its agent snapshot is missing or malformed.');
  }

  return usable;
}

function createPersistence(ctx: RunContext): RunPersistence {
  const db = getDb();

  return {
    insertProposal(input) {
      const row = insertProposal(db, {
        runId: ctx.runId,
        agentId: input.agentId,
        round: input.round,
        title: input.title,
        description: input.description,
        rationale: input.rationale,
        feasibilityWeeks: input.feasibilityWeeks,
        parentProposalId: input.parentProposalId,
        status: 'active',
      });
      ctx.proposals = [...ctx.proposals, row];
      return row;
    },

    setProposalStatus(proposalId, status) {
      updateProposalStatus(db, proposalId, status);
      ctx.proposals = ctx.proposals.map((proposal) =>
        proposal.id === proposalId ? { ...proposal, status } : proposal,
      );
    },

    insertCritique(input) {
      const row = insertCritique(db, {
        runId: ctx.runId,
        agentId: input.agentId,
        targetProposalId: input.targetProposalId,
        stance: input.stance as CritiqueRow['stance'],
        comment: input.comment,
        round: input.round,
      });
      ctx.critiques = [...ctx.critiques, row];
      return row;
    },

    upsertVote(input) {
      const row = upsertVote(db, {
        runId: ctx.runId,
        agentId: input.agentId,
        proposalId: input.proposalId,
        score: input.score,
        weightAtVote: input.weightAtVote,
        weightedScore: input.weightedScore,
        comment: input.comment,
      });
      ctx.votes = [...ctx.votes.filter((vote) => vote.id !== row.id), row];
      return row;
    },

    insertMessage(record) {
      // Section 11.6: the unique index on `task_key` is what makes a retried
      // write a no-op rather than a duplicate. `onConflictDoNothing` is the
      // database-level enforcement of that, and the returned `changes` tells
      // the engine whether this was the first successful write.
      const changes = db
        .insert(agentMessages)
        .values({
          id: newId(),
          runId: ctx.runId,
          agentId: record.agentId,
          step: record.step,
          taskKey: record.taskKey,
          requestJson: record.requestJson,
          reasoningText: record.reasoningText,
          contentText: record.contentText,
          tokensIn: record.tokensIn,
          tokensOut: record.tokensOut,
          costUsd: record.costUsd,
          latencyMs: record.latencyMs,
          finishReason: record.finishReason,
          error: record.error,
          createdAt: nowMs(),
        })
        .onConflictDoNothing({ target: agentMessages.taskKey })
        .run().changes;
      return changes > 0;
    },

    existingTaskKeys() {
      const rows = db
        .select({ taskKey: agentMessages.taskKey })
        .from(agentMessages)
        .where(eq(agentMessages.runId, ctx.runId))
        .all();
      return new Set(rows.map((row) => row.taskKey));
    },

    reload() {
      ctx.proposals = listProposals(db, ctx.runId);
      ctx.critiques = listCritiques(db, ctx.runId);
      ctx.votes = listVotes(db, ctx.runId);
      const fresh = getRun(db, ctx.runId);
      if (fresh) ctx.run = fresh;
    },

    setStep(step) {
      const row = setRunStep(db, ctx.runId, step, stepIndex(step));
      if (row) ctx.run = row;
    },

    setRound(round) {
      const row = updateRun(db, ctx.runId, { round });
      if (row) ctx.run = row;
    },

    patchRun(patch) {
      const row = updateRun(db, ctx.runId, patch);
      if (row) ctx.run = row;
    },

    bumpUsage(delta) {
      ctx.usage.tokensIn += delta.tokensIn;
      ctx.usage.tokensOut += delta.tokensOut;
      ctx.usage.costUsd += delta.costUsd;
      ctx.usage.calls += delta.calls;
      bumpRunUsage(db, ctx.runId, {
        tokensIn: delta.tokensIn,
        tokensOut: delta.tokensOut,
        costUsd: delta.costUsd,
        llmCalls: delta.calls,
      });
    },
  };
}

/** Re-export so a consumer does not need two imports to name the snapshot. */
export type { RunConfigSnapshot };
