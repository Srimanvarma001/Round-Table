import { REPAIR_LABEL_SUFFIX } from './json';
import {
  LLMError,
  type AgentCallRequest,
  type AgentCallResult,
  type LLMAdapter,
  type LLMDelta,
} from './types';

/**
 * Scripted adapter for integration tests, section 19.2.
 *
 * `MockLLMAdapter` implements `LLMAdapter`, replays scripted deltas with a
 * configurable latency, injects failures on demand, and records every request
 * it serves so a test can assert on call counts and ordering.
 *
 * It deliberately does NOT import `server-only`: vitest has to be able to
 * import it, and it holds no secrets.
 *
 * Two modes:
 *  - scripted — `setScript(fn)` returns the assistant text for a given
 *    (agentId, step) pair. This is how per-seat scenarios are driven: one
 *    seat returning malformed JSON, one seat failing every call, and so on.
 *  - default — with no script, a deterministic valid payload is synthesised
 *    for the step, so a full happy-path run works out of the box.
 */

/** Steps the mock knows how to synthesise a payload for. */
export const MOCK_STEPS = ['propose', 'debate', 'refine', 'vote', 'reveal', 'extract'] as const;
export type MockStep = (typeof MOCK_STEPS)[number];

/** The fixed reasoning delta every mock call emits before its content. */
export const MOCK_REASONING_TEXT =
  'Reading the brief through this seat’s lens: first the constraint it collides with, ' +
  'then the version of the idea that survives it.';

/**
 * How an injected failure should be classified, so a test can drive either the
 * "seat failed, scheduler moved on" path (client) or the "provider outage with
 * retries" path (server / network).
 */
export type MockFailureMode = 'client' | 'server' | 'network';

export interface MockCallContext {
  request: AgentCallRequest;
  /** 1-based sequence across this adapter instance's lifetime. */
  callNumber: number;
  /** 1-based attempt for THIS task identity (2 on a repair retry). */
  attempt: number;
  /** Step inferred from the request label or prompt. */
  step: MockStep;
}

/**
 * Returns the assistant text to replay, or `null` / `undefined` to fall
 * through to the built-in deterministic payload for the step.
 */
export type MockScript = (ctx: MockCallContext) => string | null | undefined;

export interface MockLLMAdapterOptions {
  /** Delay applied before every emitted delta. Zero by default. */
  latencyMs?: number;
  /** Fail the first N calls this adapter serves, then behave normally. */
  failTimes?: number;
  /**
   * Fail every call whose request label or model id contains one of these
   * strings (case-insensitive). This is the "one seat's every call fails" and
   * "all seats on a provider fail" driver from section 19.2.
   */
  failSeats?: string[];
  /** Per-(agentId, step) scripted payloads. */
  script?: MockScript | null;
  /** Classification used for injected failures. Defaults to `'client'`. */
  failureMode?: MockFailureMode;
  /** Arbitrary extra failure predicate, evaluated after the built-in rules. */
  failIf?: ((ctx: MockCallContext) => boolean) | null;
  /** Titles the synthesised debate/refine/vote payloads may reference. */
  seedTitles?: string[];
}

/** One recorded call: the request plus everything the adapter produced for it. */
export interface MockCallRecord {
  request: AgentCallRequest;
  /** 1-based sequence across this adapter instance's lifetime. */
  callNumber: number;
  /** 1-based attempt for this task identity. */
  attempt: number;
  step: MockStep;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
  /**
   * True when the call ended without throwing. An aborted call counts as ok:
   * the caller cancelled it deliberately, nothing failed.
   */
  ok: boolean;
  /** Injected-failure message when `ok` is false. */
  error?: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string;
  reasoningText: string;
  contentText: string;
}

export class MockLLMAdapter implements LLMAdapter {
  private latencyMs: number;
  private failTimes: number;
  private failSeats: readonly string[];
  private failureMode: MockFailureMode;
  private failIf: ((ctx: MockCallContext) => boolean) | undefined;

  private scriptFn: MockScript | null = null;
  private failuresServed = 0;
  private knownTitles: string[] = [];
  private readonly seedTitles: readonly string[];

  /** Every request this adapter has served, in order. Assertions read this. */
  readonly calls: MockCallRecord[] = [];

  constructor(options: MockLLMAdapterOptions = {}) {
    this.latencyMs = Math.max(0, options.latencyMs ?? 0);
    this.failTimes = Math.max(0, options.failTimes ?? 0);
    this.failSeats = (options.failSeats ?? []).map((s) => s.toLowerCase()).filter(Boolean);
    this.failureMode = options.failureMode ?? 'client';
    this.failIf = options.failIf ?? undefined;
    if (options.script) this.scriptFn = options.script;
    this.seedTitles = options.seedTitles ?? [];
    this.knownTitles = [...this.seedTitles];
  }

  /** Swap in a script after construction, e.g. between test cases. */
  setScript(script: MockScript | null): void {
    this.scriptFn = script;
  }

  /**
   * Reconfigure failure injection and latency after construction, e.g. between
   * integration cases that share the registry's memoised instance. Unspecified
   * fields keep their current values; call `reset()` alongside to clear the
   * recorded calls and the failure counter. Pass `null` for `failIf` or
   * `script` to clear a previously installed one.
   */
  configure(options: MockLLMAdapterOptions): void {
    if (options.latencyMs !== undefined) this.latencyMs = Math.max(0, options.latencyMs);
    if (options.failTimes !== undefined) {
      this.failTimes = Math.max(0, options.failTimes);
      this.failuresServed = 0;
    }
    if (options.failSeats !== undefined) {
      this.failSeats = options.failSeats.map((s) => s.toLowerCase()).filter(Boolean);
    }
    if (options.failureMode !== undefined) this.failureMode = options.failureMode;
    if (options.failIf !== undefined) this.failIf = options.failIf ?? undefined;
    if (options.script !== undefined) this.scriptFn = options.script ?? null;
  }

  /**
   * Clear recorded calls, synthesised titles and failure counters, returning
   * the adapter to its post-construction state. Constructor options
   * (`failTimes`, `failSeats`, `seedTitles`) are preserved.
   */
  reset(): void {
    this.calls.length = 0;
    this.failuresServed = 0;
    this.knownTitles = [...this.seedTitles];
  }

  /** Convenience view: just the requests, in order. */
  get requests(): AgentCallRequest[] {
    return this.calls.map((c) => c.request);
  }

  /** Deltas only — the caller drives the recording via `complete()`. */
  async *stream(req: AgentCallRequest, signal: AbortSignal): AsyncGenerator<LLMDelta> {
    const record = this.begin(req);
    try {
      if (signal.aborted) return;
      this.maybeFail(req, record);

      await this.tick(signal);
      if (signal.aborted) return;
      record.reasoningText += MOCK_REASONING_TEXT;
      yield { kind: 'reasoning', text: MOCK_REASONING_TEXT };

      const body = this.composeContent(req, record);
      for (const chunk of splitForStreaming(body)) {
        await this.tick(signal);
        if (signal.aborted) return;
        record.contentText += chunk;
        yield { kind: 'text', text: chunk };
      }

      record.finishReason = 'stop';
      record.ok = true;
    } catch (err) {
      record.ok = false;
      record.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      record.finishedAt = Date.now();
      record.latencyMs = record.finishedAt - record.startedAt;
      record.tokensIn = estimateTokens(req);
      record.tokensOut = estimateTokensFromText(record.reasoningText + record.contentText);
    }
  }

  /**
   * `stream()` plus accumulation, mirroring the real adapter's single wire
   * path so tests exercise the same shape the production code does.
   */
  async complete(req: AgentCallRequest, signal: AbortSignal): Promise<AgentCallResult> {
    const startedAt = Date.now();
    const recordIndex = this.calls.length;

    let reasoningText = '';
    let contentText = '';

    for await (const delta of this.stream(req, signal)) {
      if (delta.kind === 'reasoning') reasoningText += delta.text;
      else contentText += delta.text;
    }

    const record = this.calls[recordIndex];
    return {
      reasoningText,
      contentText,
      tokensIn: record?.tokensIn ?? estimateTokens(req),
      tokensOut: record?.tokensOut ?? estimateTokensFromText(reasoningText + contentText),
      finishReason: record?.finishReason || (signal.aborted ? 'aborted' : 'stop'),
      latencyMs: Date.now() - startedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private begin(req: AgentCallRequest): MockCallRecord {
    const callNumber = this.calls.length + 1;
    const record: MockCallRecord = {
      request: req,
      callNumber,
      attempt: this.attemptFor(req),
      step: inferStep(req),
      startedAt: Date.now(),
      finishedAt: 0,
      latencyMs: 0,
      ok: true,
      tokensIn: 0,
      tokensOut: 0,
      finishReason: '',
      reasoningText: '',
      contentText: '',
    };
    this.calls.push(record);
    return record;
  }

  private attemptFor(req: AgentCallRequest): number {
    const identity = taskIdentity(req);
    let seen = 0;
    for (const call of this.calls) {
      if (taskIdentity(call.request) === identity) seen += 1;
    }
    return seen + 1;
  }

  private maybeFail(req: AgentCallRequest, record: MockCallRecord): void {
    const context: MockCallContext = {
      request: req,
      callNumber: record.callNumber,
      attempt: record.attempt,
      step: record.step,
    };

    let injected = this.failuresServed < this.failTimes;
    if (!injected && this.failSeats.length > 0) {
      const haystack = `${req.label ?? ''} ${req.modelId}`.toLowerCase();
      injected = this.failSeats.some((needle) => haystack.includes(needle));
    }
    if (!injected && this.failIf) injected = this.failIf(context);
    if (!injected) return;

    this.failuresServed += 1;

    const where = req.label ?? `${req.provider}/${req.modelId}`;
    const classification =
      this.failureMode === 'server'
        ? { retryable: true, status: 503, code: 'SERVER_ERROR' }
        : this.failureMode === 'network'
          ? { retryable: true, code: 'NETWORK' }
          : { retryable: false, status: 400, code: 'CLIENT_ERROR' };

    const error = new LLMError(
      `MockLLMAdapter: injected ${this.failureMode} failure for "${where}".`,
      classification,
    );
    record.error = error.message;
    throw error;
  }

  private composeContent(req: AgentCallRequest, record: MockCallRecord): string {
    const scripted = this.scriptFn?.({
      request: req,
      callNumber: record.callNumber,
      attempt: record.attempt,
      step: record.step,
    });
    if (typeof scripted === 'string' && scripted.length > 0) return scripted;

    const payload = this.defaultPayload(req, record.step);
    // Remember every title the mock invents so the later steps can reference
    // real ones: the engine resolves `target_title` / `proposal_title` by
    // normalised string match and drops what it cannot resolve, so a mock that
    // invented a fresh title per step would degrade every critique and vote.
    for (const title of collectTitles(payload)) {
      if (!this.knownTitles.includes(title)) this.knownTitles.push(title);
    }
    return JSON.stringify(payload);
  }

  private defaultPayload(req: AgentCallRequest, step: MockStep): Record<string, unknown> {
    const hash = fnv1a(`${req.label ?? ''}|${req.modelId}|${req.messages.at(-1)?.content.slice(0, 240) ?? ''}`);
    const pool = this.knownTitles.length > 0 ? this.knownTitles : [syntheticTitle(hash)];

    switch (step) {
      case 'propose': {
        const title = syntheticTitle(hash);
        return {
          proposals: [
            {
              title,
              description:
                `${title} is scoped to a single afternoon of setup and a week of use. ` +
                'It works entirely from data the user already owns and produces one durable artefact. ' +
                'Nothing is uploaded, and the first version is deliberately too small to fail.',
              rationale:
                'It is the smallest version of the idea that still produces something worth keeping, ' +
                'which is what this lens optimises for.',
              feasibility_weeks: 1 + (hash % 8),
            },
          ],
        };
      }

      case 'debate': {
        const first = pool[hash % pool.length] ?? pool[0];
        const second = pool[(hash + 1) % pool.length] ?? pool[0];
        const critiques = [
          {
            target_title: first,
            stance: 'attack',
            comment:
              'The scope assumes the user will keep feeding it, and nothing in the design survives the ' +
              'second week when that stops.',
          },
        ];
        if (second !== first) {
          critiques.push({
            target_title: second,
            stance: 'extend',
            comment:
              'Worth keeping, but it only pays off if it is merged with the tooling the user already runs ' +
              'daily rather than standing beside it.',
          });
        }
        return { critiques };
      }

      case 'refine': {
        const first = pool[hash % pool.length] ?? pool[0];
        const second = pool[(hash + 1) % pool.length] ?? pool[0];
        return {
          refined: {
            title: `Focused ${first}`.slice(0, 80),
            description:
              'The critique is accepted: the scope is cut to the one workflow that produces an artefact ' +
              'on day one. The rest is deferred to a second pass that only happens if the first is used.',
            rationale:
              'Absorbed the scope objection instead of defending it, and folded in the adjacent tooling ' +
              'the extend critique pointed at.',
            merges_proposal_titles: second !== first ? [first, second] : [first],
          },
        };
      }

      case 'vote': {
        const votes = pool.map((title, index) => ({
          proposal_title: title,
          score: 4 + ((hash + index * 3) % 6),
          comment:
            'Plausible and cheap to test; the deciding factor is whether the first version produces ' +
            'anything the user would show someone else.',
        }));
        return { votes };
      }

      case 'reveal': {
        return {
          title: 'The Narrow Slice',
          description:
            'Take the winning proposal and cut it to the one workflow that produces a usable artefact on ' +
            'the first day. Everything else that was proposed stays on the shelf, unscheduled, until that ' +
            'first slice has been used twice. The votes converged on the smallest version of the idea, ' +
            'and the dissent was about scope rather than direction.',
          why_it_won:
            'It scored consistently across the lens seats rather than spiking with one, and it survived ' +
            'the harshest critique without needing to grow. The seats that scored it low did so on ' +
            'ambition, not on feasibility.',
          first_steps: [
            'Write down the single artefact the first version must produce.',
            'Build the smallest path that produces it, ignoring every other feature.',
            'Use it twice before adding anything.',
            'Record what actually got in the way, in writing.',
          ],
          risks: [
            'The scope creeps back the moment the first version works.',
            'The one workflow chosen turns out to be the least frequent one.',
            'Nothing here is validated against a second user.',
          ],
        };
      }

      case 'extract': {
        return {
          items: [
            {
              kind: 'skill',
              label: 'TypeScript',
              detail: 'Appears as the primary language across the most recently updated repositories.',
              confidence: 0.9,
            },
            {
              kind: 'taste',
              label: 'Prefers offline-first tools',
              detail: 'Repeated notes favour tools that keep working without a network connection.',
              confidence: 0.6,
            },
          ],
        };
      }
    }
  }

  /** `latencyMs` is applied before every emitted delta and respects the signal. */
  private async tick(signal: AbortSignal): Promise<void> {
    if (this.latencyMs <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, this.latencyMs);
      function finish() {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Step markers are read off the prompt, which states schema fields verbatim. */
const STEP_MARKERS: ReadonlyArray<readonly [MockStep, readonly string[]]> = [
  ['reveal', ['why_it_won', 'first_steps']],
  ['refine', ['merges_proposal_titles']],
  ['vote', ['proposal_title']],
  ['debate', ['target_title', 'critiques']],
  ['extract', ['anti_pattern']],
  ['propose', ['proposals']],
];

/**
 * Work out which step a request belongs to. The label wins when it names a
 * step (the engine's task keys are step-prefixed); otherwise the prompt is
 * scanned for the schema field names that Appendix A injects verbatim.
 * The order of `STEP_MARKERS` matters: `proposals` (Propose) also appears in
 * the context handed to later steps, so it is checked last.
 */
export function inferStep(req: AgentCallRequest): MockStep {
  const label = (req.label ?? '').toLowerCase();
  for (const step of MOCK_STEPS) {
    if (label.includes(step)) return step;
  }

  const haystack = req.messages.map((m) => m.content).join('\n').toLowerCase();
  for (const [step, markers] of STEP_MARKERS) {
    if (markers.some((marker) => haystack.includes(marker))) return step;
  }
  return 'propose';
}

/**
 * The identity two calls must share to be attempts of the same task.
 *
 * `label` is the only stable handle a request carries (`AgentCallRequest` has
 * no agentId or step), so it is the identity. `json.ts` appends a suffix to the
 * label on its repair retry, which would otherwise make the retry look like a
 * brand new task and report `attempt: 1` — the exact case a test scripts with
 * "fail on attempt 1, succeed on attempt 2", so the suffix is stripped back off
 * here.
 */
function taskIdentity(req: AgentCallRequest): string {
  const label = req.label?.endsWith(REPAIR_LABEL_SUFFIX)
    ? req.label.slice(0, -REPAIR_LABEL_SUFFIX.length)
    : req.label;
  return label ?? `${req.provider}:${req.modelId}`;
}

const TITLE_MODIFIERS = [
  'Ambient', 'Offline-First', 'Local', 'Threaded', 'Scheduled', 'Declarative',
  'Composable', 'Ephemeral', 'Federated', 'Deterministic', 'Incremental', 'Portable',
];

const TITLE_NOUNS = [
  'Reading Queue', 'Recipe Index', 'Run Journal', 'Coastline Atlas', 'Practice Log',
  'Sample Vault', 'Trail Planner', 'Bread Ledger', 'Field Notes', 'Sound Map',
  'Seed Catalogue', 'Route Sketchpad',
];

function syntheticTitle(hash: number): string {
  const modifier = TITLE_MODIFIERS[hash % TITLE_MODIFIERS.length];
  const noun = TITLE_NOUNS[Math.floor(hash / TITLE_MODIFIERS.length) % TITLE_NOUNS.length];
  return `${modifier} ${noun}`;
}

/** Pull `title` / `proposal_title` / `target_title` values out of a payload. */
function collectTitles(payload: Record<string, unknown>): string[] {
  const titles: string[] = [];
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) scan(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string' && (key === 'title' || key.endsWith('_title'))) {
        titles.push(entry);
      } else {
        scan(entry);
      }
    }
  };
  scan(payload);
  return titles;
}

/** Split the body so tests exercise multi-chunk accumulation. */
function splitForStreaming(body: string): string[] {
  if (body.length <= 2) return [body];
  const third = Math.ceil(body.length / 3);
  const chunks: string[] = [];
  for (let i = 0; i < body.length; i += third) chunks.push(body.slice(i, i + third));
  return chunks;
}

function estimateTokens(req: AgentCallRequest): number {
  return estimateTokensFromText(req.messages.map((m) => m.content).join(''));
}

/** Section 8.3 rule 2, mirrored so the mock reports plausible token counts. */
function estimateTokensFromText(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/** FNV-1a, 32-bit. Deterministic across runs and processes. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
