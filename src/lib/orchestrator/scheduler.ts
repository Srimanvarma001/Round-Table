import 'server-only';

import { callWithStructuredOutput, REPAIR_INSTRUCTION, REPAIR_LABEL_SUFFIX, parseStructured } from '@/lib/llm/json';
import { resolveAdapter } from '@/lib/llm/registry';
import {
  BudgetExceededError,
  StructuredOutputError,
  LLMError,
  classifyError,
  type AgentCallRequest,
  type AgentCallResult,
  type LLMAdapter,
} from '@/lib/llm/types';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRIES,
  RETRY_BACKOFF_MS,
} from '@/shared/constants';

import type { BudgetGuard, CostEstimator } from './budget';
import { emit, type DeltaCoalescingBus } from './bus';
import { agentById, seatNameFor, type RunContext, type RunSettings, type StepResult, type StepTask, type StepTaskFailureData } from './context';

/**
 * The task scheduler: a concurrency pool, the pause flag, and the retry
 * policy. Sections 11.4 and 17.1.
 *
 * ## Streaming, and why this file drives `stream()` itself
 *
 * `lib/llm/json.ts` offers `callWithStructuredOutput()`, which validates and
 * performs one repair retry — but it is built on `adapter.complete()`, and
 * `complete()` accumulates the stream internally without exposing a single
 * delta. Section 13.2 requires live `agent.delta` events ("the bus MUST
 * coalesce text deltas before publishing") and section 16.5/16.10 build the
 * thinking indicator and the staggered reveal on top of them, so a task that
 * goes through `complete()` has no live stream at all.
 *
 * The scheduler therefore has two call paths:
 *
 *  - **`stream: true` (the default, every seat task).** Deltas are pumped to
 *    the seat through `task.onDelta` and to the bus through
 *    `publishDelta()`, the text is parsed with `parseStructured()`, and a
 *    failed validation triggers the same single repair retry that
 *    `callWithStructuredOutput()` performs — same instruction, same label —
 *    so the two paths cannot drift in behaviour. Token counts fall back to
 *    the section 8.3 rule 2 character estimate, because `LLMDelta` carries no
 *    usage block; the provider's real usage is unreachable from `stream()`.
 *  - **`stream: false`.** `callWithStructuredOutput()` drives `complete()`,
 *    so the run gets the provider's *real* token usage and the module's own
 *    repair retry. Used for the one call with no seat to animate: the reveal
 *    synthesis (section 11.3, "1 total, non-agent").
 *
 * ## Pause semantics, section 11.4
 *
 * > The scheduler checks `pause_requested` before dispatching each task.
 * > In-flight calls are never aborted; they run to completion, stream, and
 * > persist normally.
 *
 * Implemented literally: the flag is read at the top of every worker loop
 * iteration and before every retry, and nowhere else. No call is ever
 * cancelled because of a pause — the only signal a call is given is the
 * per-call timeout from section 17.1. A task that was never dispatched (or
 * whose retry was interrupted) is reported as `deferred`, *not* as a failure,
 * so the engine leaves no `agent_messages` row behind and a later resume
 * retries it rather than skipping it as done.
 */

export interface SchedulerConfig {
  concurrency: number;
  retries: number;
  requestTimeoutMs: number;
  backoffMs: readonly number[];
}

export function schedulerConfigFrom(settings: RunSettings): SchedulerConfig {
  return {
    concurrency: clampInt(settings.concurrency, 1, 32, DEFAULT_CONCURRENCY),
    retries: clampInt(settings.retries, 0, 5, DEFAULT_RETRIES),
    requestTimeoutMs: clampInt(settings.requestTimeoutMs, 1_000, 600_000, DEFAULT_REQUEST_TIMEOUT_MS),
    backoffMs: RETRY_BACKOFF_MS,
  };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface TaskFailure {
  taskKey: string;
  agentId: string;
  code: string;
  message: string;
  retryable: boolean;
  attempts: number;
}

export type TaskOutcome =
  | { kind: 'success'; task: StepTask; result: StepResult; costUsd: number }
  | { kind: 'failure'; task: StepTask; result: StepResult; costUsd: number; error: TaskFailure }
  | { kind: 'deferred'; task: StepTask; reason: 'paused' | 'aborted' };

export interface SchedulerOutcome {
  /** Task keys that resolved successfully. */
  succeeded: string[];
  failed: TaskFailure[];
  /** Claimed but abandoned because the run paused (or was aborted) first. */
  deferred: string[];
  /** Never claimed: the pool stopped before reaching them. */
  pending: string[];
  paused: boolean;
  aborted: boolean;
  /** Set when the pre-dispatch budget check refused a task (section 17.2). */
  budgetExceeded: BudgetExceededError | null;
  /** LLM calls actually issued, including retries and repairs. */
  calls: number;
}

export interface SchedulerDeps {
  runId: string;
  config: SchedulerConfig;
  bus: DeltaCoalescingBus;
  budget: BudgetGuard;
  cost: CostEstimator;
  /** Persist and publish one settled task. The engine owns this. */
  onSettled(outcome: TaskOutcome): Promise<void>;
  isPauseRequested(): boolean;
  isAborted(): boolean;
  /** Optional teardown signal; the per-call timeout is always applied as well. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

/**
 * Run every task through a bounded pool, honouring pause, abort and budget.
 *
 * Claiming is synchronous (`queue[index++]` before any `await`), so with a
 * single-threaded runtime two workers can never claim the same task.
 */
export async function runScheduledTasks(
  ctx: RunContext,
  tasks: readonly StepTask[],
  deps: SchedulerDeps,
): Promise<SchedulerOutcome> {
  const queue = [...tasks];
  const succeeded: string[] = [];
  const failed: TaskFailure[] = [];
  const deferred: string[] = [];
  let paused = false;
  let aborted = false;
  let budgetExceeded: BudgetExceededError | null = null;
  let calls = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      // Section 11.4 rule 2: the flag is checked here — before dispatch — and
      // never used to cancel something already in flight.
      if (deps.isAborted()) {
        aborted = true;
        return;
      }
      if (deps.isPauseRequested()) {
        paused = true;
        return;
      }
      try {
        // Section 17.2: the guard is checked before dispatching, so a refusal
        // can never orphan a partial result.
        deps.budget.check();
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetExceeded = err;
          return;
        }
        throw err;
      }

      const task = queue[next];
      if (!task) return;
      next += 1;

      await dispatchStatus(ctx, task, deps);

      const outcome = await executeTask(ctx, task, deps);
      calls += countCalls(outcome);
      await deps.onSettled(outcome);

      if (outcome.kind === 'success') {
        succeeded.push(task.taskKey);
      } else if (outcome.kind === 'failure') {
        failed.push(outcome.error);
      } else {
        deferred.push(task.taskKey);
        if (outcome.reason === 'paused') paused = true;
        else aborted = true;
        return;
      }
    }
  };

  const width = Math.max(1, Math.min(deps.config.concurrency, queue.length || 1));
  await Promise.all(Array.from({ length: width }, () => worker()));

  return {
    succeeded,
    failed,
    deferred,
    pending: queue.slice(next).map((task) => task.taskKey),
    paused: paused && !aborted,
    aborted,
    budgetExceeded,
    calls,
  };
}

function countCalls(outcome: TaskOutcome): number {
  return outcome.kind === 'deferred' ? 0 : outcome.result.attempts;
}

/** Section 13.3: `agent.status` drives the avatar animation. */
async function dispatchStatus(ctx: RunContext, task: StepTask, deps: SchedulerDeps): Promise<void> {
  try {
    await emit(deps.bus, ctx.runId, 'agent.status', { status: 'thinking' }, {
      agentId: task.agentId,
      step: task.step,
    });
  } catch {
    // A status event is cosmetic; it must never be the reason a task fails.
  }
}

// ---------------------------------------------------------------------------
// One task, with retries
// ---------------------------------------------------------------------------

async function executeTask(
  ctx: RunContext,
  task: StepTask,
  deps: SchedulerDeps,
): Promise<TaskOutcome> {
  const maxAttempts = 1 + Math.max(0, deps.config.retries);
  let last: { result: StepResult; error: TaskFailure } | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      // A retry is a fresh dispatch, so it obeys the pause flag (11.4 rule 2).
      if (deps.isAborted()) return { kind: 'deferred', task, reason: 'aborted' };
      if (deps.isPauseRequested()) return { kind: 'deferred', task, reason: 'paused' };

      await sleep(backoffDelay(attempt - 1, deps.config.backoffMs));

      if (deps.isAborted()) return { kind: 'deferred', task, reason: 'aborted' };
      if (deps.isPauseRequested()) return { kind: 'deferred', task, reason: 'paused' };
    }

    const outcome = await attemptOnce(ctx, task, deps, attempt);
    if (outcome.ok) {
      return { kind: 'success', task, result: outcome.result, costUsd: outcome.costUsd };
    }

    last = { result: outcome.result, error: outcome.error };

    // Section 17.1: 429, 5xx, network errors and `StructuredOutputError`
    // retry; every other 4xx does not. A missing provider key is not
    // retryable and must fail fast — section 17.5 wants the seat to fail, not
    // the run to stall.
    if (!outcome.error.retryable) break;
  }

  const settled = last ?? {
    result: emptyResult(),
    error: {
      taskKey: task.taskKey,
      agentId: task.agentId,
      code: 'INTERNAL',
      message: 'Task produced no attempt outcome.',
      retryable: false,
      attempts: 0,
    },
  };

  return { kind: 'failure', task, result: settled.result, costUsd: costOf(ctx, task, settled.result, deps), error: settled.error };
}

interface AttemptOutcome {
  ok: boolean;
  result: StepResult;
  costUsd: number;
  error: TaskFailure;
}

async function attemptOnce(
  ctx: RunContext,
  task: StepTask,
  deps: SchedulerDeps,
  attempt: number,
): Promise<AttemptOutcome> {
  const startedAt = Date.now();

  try {
    const request = task.buildRequest(ctx);
    // `resolveAdapter` rather than `getAdapter`: it honours `MOCK_LLM` and the
    // `'mock'` provider, which is how the integration tests drive the loop.
    const adapter = resolveAdapter(request.provider);
    const signal = buildSignal(deps);

    if (task.stream === false) {
      const call = await callWithStructuredOutput(adapter, request, task.schema, signal);
      const result: StepResult = {
        parsed: call.value,
        contentText: call.result.contentText,
        reasoningText: call.result.reasoningText,
        tokensIn: call.result.tokensIn,
        tokensOut: call.result.tokensOut,
        finishReason: call.result.finishReason,
        latencyMs: call.result.latencyMs,
        attempts: call.attempts,
      };
      return { ok: true, result, costUsd: costOf(ctx, task, result, deps), error: noError(task, attempt) };
    }

    const { result, parsed } = await streamStructured(ctx, task, deps, adapter, request, signal);
    return { ok: true, result: { ...result, parsed }, costUsd: costOf(ctx, task, result, deps), error: noError(task, attempt) };
  } catch (err) {
    return {
      ok: false,
      result: { ...failureResultFrom(err), parsed: null, latencyMs: Date.now() - startedAt },
      costUsd: costOf(ctx, task, failureResultFrom(err), deps),
      error: classifyFailure(err, task, attempt + 1),
    };
  }
}

/**
 * Stream a call, accumulate it, and validate the result — with the same single
 * repair retry that `callWithStructuredOutput()` performs (section 8.3 rule 3).
 */
async function streamStructured(
  ctx: RunContext,
  task: StepTask,
  deps: SchedulerDeps,
  adapter: LLMAdapter,
  request: AgentCallRequest,
  signal: AbortSignal,
): Promise<{ result: Omit<StepResult, 'parsed'>; parsed: unknown }> {
  const first = await streamCall(ctx, task, deps, adapter, request, signal);
  const firstParsed = tryParse(first, task.schema);
  if (firstParsed.ok) return { result: first, parsed: firstParsed.value };

  // Mirror of lib/llm/json.ts: echo the bad reply, then correct it. Reusing
  // the module's own constants is what keeps the two paths identical.
  const repairRequest: AgentCallRequest = {
    ...request,
    label: request.label ? `${request.label}${REPAIR_LABEL_SUFFIX}` : `repair${REPAIR_LABEL_SUFFIX}`,
    messages: [
      ...request.messages,
      { role: 'assistant', content: firstParsed.rawText },
      { role: 'user', content: REPAIR_INSTRUCTION },
    ],
  };

  const second = await streamCall(ctx, task, deps, adapter, repairRequest, signal);
  const secondParsed = tryParse(second, task.schema);
  if (secondParsed.ok) {
    return { result: { ...second, attempts: 2 }, parsed: secondParsed.value };
  }

  throw new StructuredOutputError(
    'Structured output failed twice: ' +
      `${firstParsed.error.message} Then, after the repair retry: ${secondParsed.error.message}`,
    secondParsed.rawText,
  );
}

/** One streamed call. Deltas go to the seat and to the bus; usage is estimated. */
async function streamCall(
  ctx: RunContext,
  task: StepTask,
  deps: SchedulerDeps,
  adapter: LLMAdapter,
  request: AgentCallRequest,
  signal: AbortSignal,
): Promise<Omit<StepResult, 'parsed'>> {
  const startedAt = Date.now();
  let contentText = '';
  let reasoningText = '';

  for await (const delta of adapter.stream(request, signal)) {
    if (delta.kind === 'reasoning') reasoningText += delta.text;
    else contentText += delta.text;

    // Section 11.3's hook, then section 13.2's coalescing publish. The bus
    // owns the 40ms/40 char window, so this stays a cheap append.
    task.onDelta(delta);
    deps.bus.publishDelta(ctx.runId, task.agentId, task.step, delta);
  }

  const latencyMs = Date.now() - startedAt;

  return {
    contentText,
    reasoningText,
    // Section 8.3 rule 2, the documented fallback: `stream()` yields no usage
    // block, so the budget guard is fed the character estimate rather than
    // nothing at all. Reasoning tokens are billed as completion tokens by both
    // providers (PROVIDER-NOTES section 4), so they count towards `tokensOut`.
    tokensIn: estimateTokensFromChars(requestChars(request)),
    tokensOut: estimateTokensFromChars(contentText.length + reasoningText.length),
    finishReason: signal.aborted ? 'aborted' : contentText || reasoningText ? 'stop' : 'empty',
    latencyMs,
    attempts: 1,
  };
}

function tryParse(
  result: Omit<StepResult, 'parsed'>,
  schema: StepTask['schema'],
): { ok: true; value: unknown } | { ok: false; error: Error; rawText: string } {
  // PROVIDER-NOTES section 5: a reasoning model will put the JSON in the
  // reasoning channel and leave the content channel empty, so content is
  // preferred and reasoning is the fallback — never merged.
  const rawText = result.contentText.trim().length > 0 ? result.contentText : result.reasoningText;

  if (rawText.trim().length === 0) {
    return {
      ok: false,
      error: new StructuredOutputError('The model returned no text in either channel.', rawText),
      rawText,
    };
  }

  try {
    return { ok: true, value: parseStructured(rawText, schema) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
      rawText,
    };
  }
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export function classifyFailure(err: unknown, task: StepTask, attempts: number): TaskFailure {
  const base = { taskKey: task.taskKey, agentId: task.agentId, attempts };

  if (err instanceof BudgetExceededError) {
    return { ...base, code: 'BUDGET_EXCEEDED', message: err.message, retryable: false };
  }
  if (err instanceof StructuredOutputError) {
    // Section 17.1: a schema failure IS retryable — the repair retry inside
    // the attempt already ran, and the scheduler's own retry gives the model
    // another independent chance.
    return { ...base, code: 'STRUCTURED_OUTPUT', message: err.message, retryable: true };
  }
  if (err instanceof LLMError) {
    return {
      ...base,
      code: String(err.classification.code || 'LLM_ERROR'),
      message: err.message,
      retryable: err.classification.retryable,
    };
  }

  const classification = classifyError(err);
  return {
    ...base,
    code: String(classification.code || 'INTERNAL'),
    message: err instanceof Error ? err.message : String(err),
    retryable: classification.retryable,
  };
}

/** What little we know about a call that threw before producing anything. */
function failureResultFrom(err: unknown): Omit<StepResult, 'parsed'> {
  const rawText =
    err instanceof StructuredOutputError
      ? err.rawText
      : err instanceof LLMError
        ? ''
        : '';

  return {
    contentText: rawText,
    reasoningText: '',
    tokensIn: 0,
    tokensOut: estimateTokensFromChars(rawText.length),
    finishReason: 'error',
    latencyMs: 0,
    attempts: 1,
  };
}

function emptyResult(): StepResult {
  return {
    parsed: null,
    contentText: '',
    reasoningText: '',
    tokensIn: 0,
    tokensOut: 0,
    finishReason: 'error',
    latencyMs: 0,
    attempts: 0,
  };
}

function noError(task: StepTask, attempt: number): TaskFailure {
  return {
    taskKey: task.taskKey,
    agentId: task.agentId,
    code: 'OK',
    message: '',
    retryable: false,
    attempts: attempt + 1,
  };
}

// ---------------------------------------------------------------------------
// Cost, signals, backoff
// ---------------------------------------------------------------------------

function costOf(
  ctx: RunContext,
  task: StepTask,
  result: Omit<StepResult, 'parsed'>,
  deps: SchedulerDeps,
): number {
  const seat = agentById(ctx, task.agentId);
  if (!seat) return 0;
  return deps.cost({
    provider: seat.provider,
    modelId: seat.modelId,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  });
}

/** Section 17.1: a per-call timeout of 90 seconds by default. */
function buildSignal(deps: SchedulerDeps): AbortSignal {
  const timeout = AbortSignal.timeout(deps.config.requestTimeoutMs);
  return deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
}

/**
 * Section 17.1: "exponential backoff 1s then 4s, plus jitter". Jitter is
 * half-to-full so two seats that hit a 429 together do not retry in lockstep.
 * `rng` is injectable so the policy can be unit-tested without a clock.
 */
export function backoffDelay(
  attemptIndex: number,
  backoffMs: readonly number[] = RETRY_BACKOFF_MS,
  rng: () => number = Math.random,
): number {
  if (backoffMs.length === 0) return 0;
  const base = backoffMs[Math.min(Math.max(0, attemptIndex), backoffMs.length - 1)] ?? 0;
  return Math.round(base * (0.5 + rng() * 0.5));
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function requestChars(request: AgentCallRequest): number {
  let chars = 0;
  for (const message of request.messages) chars += message.content.length;
  return chars;
}

/**
 * Section 8.3 rule 2, duplicated from `openai-compatible.ts` deliberately:
 * the orchestrator must not take a runtime dependency on the adapter module's
 * internals, and the rule is one line.
 */
function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/** Re-exported for the engine's own accounting and for tests. */
export type { AgentCallResult };
export { seatNameFor, type StepTaskFailureData };
