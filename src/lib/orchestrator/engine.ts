import 'server-only';

import { eq } from 'drizzle-orm';

import { collectDissent, distinctness } from '@/lib/agents/weights';
import { getDb, nowMs } from '@/lib/db/client';
import { runs, type RunRow } from '@/lib/db/schema';
import { getSettingsOrDefaults } from '@/lib/db/queries/settings';
import { logger } from '@/lib/logger';
import type { RunMetrics } from '@/shared/events';
import { MIN_ACTIVE_PROPOSALS, RUN_STATUSES, type RunStatus, type StepName } from '@/shared/constants';

import { BudgetGuard, budgetLimitsFrom, loadPricingRows, makeCostEstimator, type BudgetWarning } from './budget';
import { emit, getRunEventBus, type DeltaCoalescingBus } from './bus';
import {
  activeProposals,
  buildScoreboard,
  loadRunContext,
  loadRunSettings,
  nextStep,
  partialScoresFrom,
  plannedSteps,
  stepIndex,
  type RunContext,
  type StepResult,
  type StepTask,
} from './context';
import { runScheduledTasks } from './scheduler';
import { moduleForStep, stepModules } from './steps';

/**
 * The engine loop, sections 11.4 and 11.5.
 *
 * One invocation walks a run through its planned steps. The scheduler owns
 * concurrency, retries and the pause gate inside one step; the engine owns
 * everything between steps: status transitions, events, usage accounting and
 * the final metrics.
 *
 * ## Re-entry
 *
 * Route handlers can fire `start` twice — a double click, or a resume racing
 * the still-draining step that pause deferred. The `activeRuns` set makes the
 * second call a no-op rather than a second engine. In-process task keys are
 * idempotent anyway (section 11.6); skipping the duplicate loop is cheaper and
 * keeps the event stream single.
 *
 * Cross-RESTART safety is a different mechanism: `sweepStaleRuns` marks
 * `running` rows `failed` at boot (section 17.6), and a resume re-enters the
 * step past every recorded task key (section 11.6).
 */

const activeRuns = new Set<string>();

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

export interface EngineResult {
  status: RunStatus;
}

/**
 * Fire-and-forget launch used by route handlers: `POST /start` returns 202
 * while the loop keeps going. Returns `false` when this run already has an
 * engine attached in this process.
 */
export function launchRun(runId: string): boolean {
  if (activeRuns.has(runId)) return false;
  activeRuns.add(runId);
  void executeRun(runId)
    .catch((err) => {
      logger.error({ err, runId }, 'engine crashed outside its own error handling');
    })
    .finally(() => {
      activeRuns.delete(runId);
    });
  return true;
}

/** The loop itself. Awaited by the tests; the route handlers use `launchRun`. */
export async function executeRun(runId: string): Promise<EngineResult> {
  if (activeRuns.has(runId)) return { status: readStatus(runId) };
  activeRuns.add(runId);

  try {
    return await runLoop(runId);
  } finally {
    activeRuns.delete(runId);
  }
}

async function runLoop(runId: string): Promise<EngineResult> {
  const fresh = getRunRow(runId);
  if (!fresh) return { status: 'failed' };

  // Legal entries: `created` (first start) and `running` (a resume that the
  // resume handler already flipped back). Anything else is not this loop's
  // business — the handlers own those transitions.
  if (fresh.status !== 'created' && fresh.status !== 'running') {
    return { status: fresh.status };
  }

  const ctx = buildContext(runId);
  if (!ctx) return { status: readStatus(runId) };

  if (fresh.status === 'created') {
    updateRow(runId, { status: 'running', startedAt: nowMs() });
  }

  const bus = getRunEventBus();
  await emit(bus, runId, 'run.started', { steps: plannedSteps(ctx.settings.refineEnabled) });

  for (const stepModule of stepModules()) {
    // A resume re-enters at `run.currentStep`; earlier steps are already done.
    if (stepIndex(stepModule.name) < stepIndex(ctx.run.currentStep)) continue;

    // Both flags are read from the row, not from ctx.run: the pause and abort
    // handlers mutate the database, and the context copy is stale by design.
    const row = getRunRow(runId);
    if (!row) return { status: 'failed' };
    if (row.status === 'aborted') return finalizeAborted(ctx);
    if (row.pauseRequested) return pauseRun(ctx, bus);

    const skip = stepModule.shouldSkip?.(ctx) ?? false;
    if (skip) {
      logger.info({ runId, step: stepModule.name }, 'step skipped');
      advanceStep(ctx, stepModule.name);
      continue;
    }

    const stop = await runStep(ctx, stepModule.name, bus);
    if (stop !== 'ok') {
      if (stop === 'paused') return { status: 'paused' };
      if (stop === 'aborted') return finalizeAborted(ctx);
      if (stop === 'insufficient') return finalizeInsufficientProposals(ctx);
      return finalizeBudgetExceeded(ctx);
    }
  }

  return finalizeCompleted(ctx);
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

type StepStop = 'ok' | 'paused' | 'aborted' | 'budget' | 'insufficient';

async function runStep(ctx: RunContext, step: StepName, bus: DeltaCoalescingBus): Promise<StepStop> {
  const stepModule = moduleForStep(step);
  if (!stepModule) throw new Error(`No step module for ${step}`);

  await emit(bus, ctx.runId, 'step.started', { step, round: ctx.run.round });

  // Section 11.4 rule 3 on resume: "Already-completed task keys are not
  // re-requested." The filter is the unique index's application-level twin.
  const done = ctx.persist.existingTaskKeys();
  const tasks = stepModule.buildTasks(ctx).filter((task) => !done.has(task.taskKey));

  // Search enrichment is best-effort and fails into warnings, never into the
  // run (context.ts).
  if (step === 'propose' || step === 'debate') {
    const { ensureSearchResults } = await import('./context');
    await ensureSearchResults(ctx, step);
  }

  const outcome = await runScheduledTasks(ctx, tasks, {
    runId: ctx.runId,
    config: {
      concurrency: ctx.settings.concurrency,
      retries: ctx.settings.retries,
      requestTimeoutMs: ctx.settings.requestTimeoutMs,
      backoffMs: [1000, 4000],
    },
    bus,
    budget: ctx.budget,
    cost: makeCostEstimator(loadPricingRows()),
    isPauseRequested: () => getRunRow(ctx.runId)?.pauseRequested ?? false,
    isAborted: () => (getRunRow(ctx.runId)?.status ?? 'aborted') === 'aborted',
    onSettled: (settled) => settleTask(ctx, settled, bus),
  });

  if (outcome.aborted) return 'aborted';
  if (outcome.budgetExceeded) return 'budget';
  if (outcome.paused) {
    // Mid-step pause: in-flight calls drained, nothing new dispatched. Park
    // the row and name what remains, so resume re-enters this exact step
    // (section 11.4 rules 2–4).
    updateRow(ctx.runId, { status: 'paused' });
    await emit(bus, ctx.runId, 'run.paused', {
      pendingTaskKeys: [...outcome.deferred, ...outcome.pending],
      nextStep: step,
    });
    logger.info({ runId: ctx.runId, step }, 'run paused mid-step');
    return 'paused';
  }

  await stepModule.onStepComplete(ctx);

  // Section 17.3: a step whose failures leave fewer than three active
  // proposals ends the run honestly instead of voting on wreckage. Propose and
  // refine are the steps that produce proposals; debate and vote never change
  // the count, so they need no check.
  if ((step === 'propose' || step === 'refine') && activeProposals(ctx).length < MIN_ACTIVE_PROPOSALS) {
    return 'insufficient';
  }

  const summary = {
    proposals: ctx.proposals.filter((p) => p.round === ctx.run.round).length,
    critiques: ctx.critiques.length,
    refined: ctx.proposals.filter((p) => p.parentProposalId !== null).length,
    votes: ctx.votes.length,
    failedSeats: [...new Set(ctx.failedSeats.map((f) => f.seatName))],
    warnings: [...ctx.warnings],
  };

  // Section 16.7: the vote step's completion carries the incremental plinth.
  const partials = step === 'vote' ? { partialScores: partialScoresFrom(ctx) } : {};
  await emit(bus, ctx.runId, 'step.completed', { step, summary, ...partials }, { step });

  advanceStep(ctx, step);

  if (outcome.deferred.length > 0 || outcome.pending.length > 0) {
    await emit(bus, ctx.runId, 'run.paused', {
      pendingTaskKeys: [...outcome.deferred, ...outcome.pending],
      nextStep: step,
    });
  }

  return 'ok';
}

// ---------------------------------------------------------------------------
// Task settlement
// ---------------------------------------------------------------------------

type SettledOutcome = Awaited<Parameters<import('./scheduler').SchedulerDeps['onSettled']>>[0];

async function settleTask(
  ctx: RunContext,
  settled: SettledOutcome,
  bus: DeltaCoalescingBus,
): Promise<void> {
  if (settled.kind === 'deferred') return;

  const { task, result } = settled;

  // One message row per logical task: `insertMessage` no-ops through the
  // unique index when the key is already recorded (section 11.6), which is
  // what makes a re-settled retry free.
  const firstWrite = ctx.persist.insertMessage({
    agentId: task.agentId,
    step: task.step,
    taskKey: task.taskKey,
    requestJson: { taskKey: task.taskKey, step: task.step },
    reasoningText: result.reasoningText,
    contentText: result.contentText,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: settled.costUsd,
    latencyMs: result.latencyMs,
    finishReason: result.finishReason,
    error:
      settled.kind === 'failure'
        ? `${settled.error.code}: ${settled.error.message}`
        : null,
  });

  ctx.persist.bumpUsage({
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: settled.costUsd,
    calls: 1,
  });

  // A failed call still consumed tokens, so the guard records it too
  // (section 17.2). The warning is emitted once, at 80 percent.
  const warning = ctx.budget.record({
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: settled.costUsd,
    calls: 1,
  });
  if (warning && firstWrite) {
    await emit(bus, ctx.runId, 'budget.warning', {
      usedUsd: warning.usedUsd,
      limitUsd: warning.limitUsd,
      pct: warning.pct,
    });
    ctx.warnings.push(
      `Budget warning: ${warning.usedUsd.toFixed(4)} of ${warning.limitUsd.toFixed(2)} USD used.`,
    );
  }

  if (settled.kind === 'failure') {
    const seat = ctx.snapshot.find((s) => s.id === task.agentId);
    if (seat) {
      ctx.failedSeats.push({
        agentId: seat.id,
        seatName: seat.name,
        step: task.step,
        code: settled.error.code,
        message: settled.error.message,
        retryable: settled.error.retryable,
      });
    }
    await emit(
      bus,
      ctx.runId,
      'agent.failed',
      { code: settled.error.code, message: settled.error.message, retryable: settled.error.retryable },
      { agentId: task.agentId, step: task.step },
    );
    return;
  }

  await task.applyResult(ctx, result);
  ctx.scratch.clearTask(task.taskKey);

  const partial = task.enrichDone?.(ctx);
  await emit(
    bus,
    ctx.runId,
    'agent.done',
    {
      finalText: result.contentText,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: settled.costUsd,
      latencyMs: result.latencyMs,
      ...(partial?.partialScores ? { partialScores: partial.partialScores } : {}),
    },
    { agentId: task.agentId, step: task.step },
  );
}

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

async function pauseRun(ctx: RunContext, bus: DeltaCoalescingBus): Promise<EngineResult> {
  // Section 11.4 rule 3: the UI shows exactly what remains, so the pending
  // keys are the current step's tasks minus the idempotent already-done set —
  // never a guess, never empty when work is actually outstanding.
  let pendingTaskKeys: string[] = [];
  if (ctx.run.currentStep !== 'done') {
    const pausedModule = moduleForStep(ctx.run.currentStep);
    if (pausedModule) {
      const done = ctx.persist.existingTaskKeys();
      pendingTaskKeys = pausedModule
        .buildTasks(ctx)
        .filter((task) => !done.has(task.taskKey))
        .map((task) => task.taskKey);
    }
  }
  updateRow(ctx.runId, { status: 'paused' });
  await emit(bus, ctx.runId, 'run.paused', {
    pendingTaskKeys,
    nextStep: ctx.run.currentStep === 'done' ? 'reveal' : ctx.run.currentStep,
  });
  logger.info({ runId: ctx.runId, pending: pendingTaskKeys.length }, 'run paused');
  return { status: 'paused' };
}

async function finalizeAborted(ctx: RunContext): Promise<EngineResult> {
  // Terminal, keeps data (section 14): completed artefacts stay browsable.
  updateRow(ctx.runId, { status: 'aborted', completedAt: nowMs() });
  // The payload names a step, not `done`: an abort after the last step still
  // reports the step it finished.
  const atStep = ctx.run.currentStep === 'done' ? 'reveal' : ctx.run.currentStep;
  await emit(getRunEventBus(), ctx.runId, 'run.aborted', { atStep });
  return { status: 'aborted' };
}

async function finalizeBudgetExceeded(ctx: RunContext): Promise<EngineResult> {
  updateRow(ctx.runId, {
    status: 'failed',
    errorCode: 'BUDGET_EXCEEDED',
    errorMessage: 'The run budget was reached before the table finished.',
    completedAt: nowMs(),
  });
  await emit(getRunEventBus(), ctx.runId, 'run.failed', {
    code: 'BUDGET_EXCEEDED',
    message: 'The run budget was reached before the table finished.',
  });
  return { status: 'failed' };
}

async function finalizeInsufficientProposals(ctx: RunContext): Promise<EngineResult> {
  // Section 17.3: failures left fewer than three active proposals. The run
  // fails honestly with its partial artefacts preserved — browsable and
  // replayable, never silently completed on wreckage.
  const count = activeProposals(ctx).length;
  updateRow(ctx.runId, {
    status: 'failed',
    errorCode: 'INSUFFICIENT_PROPOSALS',
    errorMessage: `Only ${count} active proposal(s) survived; at least ${MIN_ACTIVE_PROPOSALS} are required to vote.`,
    completedAt: nowMs(),
  });
  await emit(getRunEventBus(), ctx.runId, 'run.failed', {
    code: 'INSUFFICIENT_PROPOSALS',
    message: `Only ${count} active proposal(s) survived; at least ${MIN_ACTIVE_PROPOSALS} are required to vote.`,
  });
  return { status: 'failed' };
}

async function finalizeCompleted(ctx: RunContext): Promise<EngineResult> {
  const metrics = buildMetrics(ctx);

  updateRow(ctx.runId, {
    status: 'completed',
    currentStep: 'done',
    stepIndex: 5,
    completedAt: nowMs(),
  });

  await emit(getRunEventBus(), ctx.runId, 'run.completed', {
    winner: ctx.reveal,
    metrics,
  });

  return { status: 'completed' };
}

/**
 * Derived metrics, section 12.5 — recomputed from stored rows, never cached.
 * The dissent rule comes from `weights.ts` so the metric and the reveal card
 * cannot disagree.
 */
export function buildMetrics(ctx: RunContext): RunMetrics {
  const board = buildScoreboard(ctx);
  const winner = board[0] ?? null;

  const winnerVotes = winner
    ? ctx.votes.filter((v) => v.proposalId === winner.proposalId)
    : [];

  const me = ctx.snapshot.find((s) => s.isMeAgent);
  const meVote = me ? winnerVotes.find((v) => v.agentId === me.id) : undefined;

  const dissent = collectDissent(
    winnerVotes.map((v) => ({ agentId: v.agentId, score: v.score })),
    true,
  );

  return {
    winnerScore: winner?.finalScore ?? 0,
    scoreSpread:
      board.length > 0 ? Math.max(...board.map((r) => r.finalScore)) - Math.min(...board.map((r) => r.finalScore)) : 0,
    meAlignment: meVote ? meVote.score >= 5 : false,
    dissentCount: dissent.length,
    distinctness: distinctness(activeProposals(ctx)),
    totalCostUsd: ctx.usage.costUsd,
    failedSeats: [...new Set(ctx.failedSeats.map((f) => f.seatName))],
  };
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/**
 * Build the run context with a REAL budget guard: limits from the run's frozen
 * `config_snapshot` over the stored settings (section 17.2), usage seeded from
 * the `runs` row so a resume cannot respend (section 11.4 rule 4).
 *
 * `loadRunContext` resolves the same settings again from the same inputs;
 * both resolutions are deterministic so they cannot disagree.
 */
function buildContext(runId: string): RunContext | null {
  const db = getDb();
  try {
    const row = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!row) return null;

    const settings = loadRunSettings(row.configSnapshot, getSettingsOrDefaults(db));
    const limits = budgetLimitsFrom({
      budgetUsd: settings.budgetUsd,
      maxTokens: settings.maxTokens,
      maxCalls: settings.maxCalls,
    });
    const budget = new BudgetGuard(limits, {
      costUsd: row.costEstimateUsd,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      calls: row.llmCalls,
    });

    return loadRunContext(runId, getRunEventBus(), budget);
  } catch (err) {
    logger.error({ err, runId }, 'context load failed');
    db.update(runs)
      .set({
        status: 'failed',
        errorCode: 'INTERNAL',
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: nowMs(),
      })
      .where(eq(runs.id, runId))
      .run();
    return null;
  }
}

function getRunRow(runId: string): RunRow | undefined {
  return getDb().select().from(runs).where(eq(runs.id, runId)).get();
}

function updateRow(runId: string, patch: Partial<RunRow>): void {
  getDb().update(runs).set(patch).where(eq(runs.id, runId)).run();
}

function readStatus(runId: string): RunStatus {
  const row = getRunRow(runId);
  const status = row?.status;
  return status && (RUN_STATUSES as readonly string[]).includes(status)
    ? (status as RunStatus)
    : 'failed';
}

/** Advance `current_step` and mirror it into the context copy. */
function advanceStep(ctx: RunContext, step: StepName): void {
  const next = nextStep(step, ctx.settings.refineEnabled);
  const index = stepIndex(next);
  updateRow(ctx.runId, {
    currentStep: next,
    stepIndex: index,
  });
  // The resume check compares against the context copy, so it must move too —
  // a stale copy would replay finished steps.
  ctx.run = { ...ctx.run, currentStep: next, stepIndex: index };
}
