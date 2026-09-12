import 'server-only';

import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

import type { ProviderName } from '@/lib/config';
import { logger } from '@/lib/logger';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/shared/constants';

import {
  LLMError,
  classifyError,
  type AgentCallRequest,
  type AgentCallResult,
  type LLMAdapter,
  type LLMDelta,
} from './types';

/**
 * The one adapter that touches the network, section 8.2.
 *
 * GLM exposes an OpenAI-compatible `/chat/completions` endpoint, so a single
 * implementation constructed with a `baseURL` and an `apiKey` serves it.
 * Everything provider-specific is isolated in `buildBody` below.
 *
 * Design rules from section 8 that this file is responsible for:
 *  - 8.1: there is exactly one place a request is ever issued — the private
 *    `execute()` generator. `stream()` yields its deltas; `complete()` is that
 *    same generator plus accumulation, so the two can never diverge.
 *  - 8.3 rule 1: reasoning and content are normalised into `LLMDelta`.
 *  - 8.3 rule 2: stream usage is requested; a missing usage block falls back
 *    to a character estimate so the budget guard always gets a number.
 *  - 8.3 rule 3: `jsonMode` is a hint only — correctness lives in `json.ts`.
 *  - 8.3 rule 4: errors are classified into retryable / not; the scheduler
 *    owns the retry, so the SDK's own retry loop is disabled.
 *
 * Every deviation from architecture.md below follows docs/PROVIDER-NOTES.md,
 * which was verified against the live APIs on 2026-09-11 and supersedes the
 * spec where the two disagree.
 */

/**
 * Reasoning headroom added to `maxTokens` for GLM calls, per
 * docs/PROVIDER-NOTES.md section 3.
 *
 * `glm-5.3-flash` always thinks and **cannot** be told not to: any
 * `thinking: { type: 'disabled' }` is rejected with a 400 ("该模型始终思考，
 * 不支持关闭思考"). Worse, the provider counts reasoning tokens against
 * `max_tokens`, so a short-budget step such as `vote` (600 tokens) spends its
 * entire budget thinking and returns `finish_reason: 'length'` with EMPTY
 * content. Without this headroom every GLM seat would silently return nothing
 * on every low-budget step.
 *
 * The value is a fixed token allowance rather than a percentage so the
 * behaviour is predictable: a `vote` call requests 600 + 2048 = 2648 tokens.
 */
export const GLM_REASONING_HEADROOM_TOKENS = 2048;

/**
 * The request body we actually send. Kept as a named type so a future provider
 * extension (a `thinking` block, for example) has an obvious home.
 */
type CompatibleChatRequest = ChatCompletionCreateParamsStreaming;

/**
 * `delta.reasoning_content` is emitted by GLM (notes section 2 — the spec
 * predicted a provider-specific field; there is just this one) and is not
 * modelled by the SDK, so deltas are read through this widened view.
 */
type ReasoningCapableDelta = ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
};

/** Usage as we care about it: either number may be absent. */
interface ProviderUsage {
  tokensIn: number | null;
  tokensOut: number | null;
}

/** What `execute()` yields: the deltas, then one terminal metadata event. */
type WireEvent =
  | { type: 'delta'; delta: LLMDelta }
  | { type: 'end'; usage: ProviderUsage | null; finishReason: string };

export interface OpenAICompatibleAdapterOptions {
  provider: ProviderName;
  /** Resolved by the registry through `providerKey()`, never read from env here. */
  apiKey: string;
  /** Resolved by the registry through `providerBaseUrl()`. */
  baseURL: string;
  /** Per-call timeout. Section 8.3 rule 5: a silent reasoning model is not stalled. */
  timeoutMs?: number;
  /**
   * The SDK's own retry loop. Defaults to 0: section 8.3 rule 4 puts retry
   * policy in the scheduler, which knows about the run budget and the pause
   * flag. A hidden SDK retry would double-count calls against `RUN_MAX_CALLS`.
   */
  maxRetries?: number;
  /**
   * Escape hatch for unit tests that replay recorded fixtures. Production code
   * always lets the constructor build the client.
   */
  client?: OpenAI;
}

export class OpenAICompatibleAdapter implements LLMAdapter {
  readonly provider: ProviderName;

  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleAdapterOptions) {
    const { provider } = options;

    // Reject an unknown provider key early and clearly rather than letting the
    // SDK fail with an opaque 404 against a nonsense base URL.
    if (provider !== 'glm') {
      throw new LLMError(
        `OpenAICompatibleAdapter cannot serve provider "${String(provider)}". ` +
          'The supported provider is "glm"; provider "mock" is served by MockLLMAdapter.',
        { retryable: false, code: 'UNKNOWN_PROVIDER' },
      );
    }
    if (!options.apiKey) {
      throw new LLMError(`No API key supplied for provider "${provider}".`, {
        retryable: false,
        code: 'MISSING_PROVIDER_KEY',
      });
    }

    this.provider = provider;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        timeout: this.timeoutMs,
        maxRetries: options.maxRetries ?? 0,
      });
  }

  /**
   * The single wire path. Yields normalised deltas as they arrive; the caller
   * owns accumulation.
   */
  async *stream(req: AgentCallRequest, signal: AbortSignal): AsyncGenerator<LLMDelta> {
    for await (const event of this.execute(req, signal)) {
      if (event.type === 'delta') yield event.delta;
    }
  }

  /**
   * `stream()` plus accumulation, per section 8.1. Token counts come from the
   * provider's usage block where present and from the section 8.3 rule 2
   * character estimate where it is not.
   */
  async complete(req: AgentCallRequest, signal: AbortSignal): Promise<AgentCallResult> {
    const startedAt = Date.now();

    let reasoningText = '';
    let contentText = '';
    let finishReason = '';
    let usage: ProviderUsage | null = null;

    for await (const event of this.execute(req, signal)) {
      if (event.type === 'delta') {
        if (event.delta.kind === 'reasoning') reasoningText += event.delta.text;
        else contentText += event.delta.text;
      } else {
        usage = event.usage;
        finishReason = event.finishReason;
      }
    }

    const latencyMs = Date.now() - startedAt;

    // Section 8.3 rule 2 / section 17.2: the budget guard must never be handed
    // `undefined`. Fall back per field, so a partial usage block still
    // contributes what it has.
    //
    // Reasoning tokens are billed as completion tokens by GLM, so the estimate
    // counts the reasoning text towards `tokensOut` too.
    const tokensIn = usage?.tokensIn ?? estimateTokensFromChars(countRequestChars(req));
    const tokensOut =
      usage?.tokensOut ?? estimateTokensFromChars(reasoningText.length + contentText.length);

    if (!finishReason) finishReason = signal.aborted ? 'aborted' : 'unknown';

    logger.debug(
      {
        provider: this.provider,
        modelId: req.modelId,
        label: req.label,
        tokensIn,
        tokensOut,
        latencyMs,
        finishReason,
        estimatedUsage: usage === null,
      },
      'llm call complete',
    );

    return { reasoningText, contentText, tokensIn, tokensOut, finishReason, latencyMs };
  }

  /**
   * Issue the request and normalise the stream. Not exported: `stream()` and
   * `complete()` are the only two public entry points, and both come through
   * here, which is what makes "one wire path" true rather than aspirational.
   */
  private async *execute(
    req: AgentCallRequest,
    signal: AbortSignal,
  ): AsyncGenerator<WireEvent> {
    // A seat configured for one provider must not be dispatched through the
    // other provider's key and base URL.
    if (req.provider !== this.provider) {
      throw new LLMError(
        `Provider mismatch: this adapter serves "${this.provider}" but the request asked for ` +
          `"${String(req.provider)}".`,
        { retryable: false, code: 'PROVIDER_MISMATCH' },
      );
    }

    // Already cancelled: fail fast rather than burn a network round trip.
    if (signal.aborted) {
      throw new LLMError(`[${this.provider}] request aborted before dispatch.`, {
        retryable: false,
        code: 'ABORTED',
      });
    }

    const body = this.buildBody(req);

    let chunks: AsyncIterable<ChatCompletionChunk>;
    try {
      chunks = await this.client.chat.completions.create(body, { signal });
    } catch (err) {
      throw this.toLLMError(err);
    }

    let usage: ProviderUsage | null = null;
    let finishReason = '';

    try {
      for await (const chunk of chunks) {
        // Honour the signal ourselves as well as handing it to the SDK: the
        // SDK tears the socket down, but a chunk already buffered in the
        // iterator would otherwise still be emitted.
        if (signal.aborted) break;

        const chunkUsage = readUsage(chunk.usage);
        if (chunkUsage) usage = chunkUsage;

        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta as ReasoningCapableDelta;

          // Notes section 2: GLM puts reasoning here. Normalising the single
          // field name is the whole of rule 1's job now.
          const reasoning = delta.reasoning_content;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            yield { type: 'delta', delta: { kind: 'reasoning', text: reasoning } };
          }

          const content = delta.content;
          if (typeof content === 'string' && content.length > 0) {
            yield { type: 'delta', delta: { kind: 'text', text: content } };
          }
        }
      }
    } catch (err) {
      // An abort surfaces from the SDK as an abort error. Aborting is a caller
      // decision (pause / run cancel), not a transport failure, so the stream
      // ends quietly with whatever was accumulated before the signal.
      if (!signal.aborted) throw this.toLLMError(err);
    }

    if (signal.aborted && !finishReason) finishReason = 'aborted';

    yield { type: 'end', usage, finishReason };
  }

  /**
   * Translate an `AgentCallRequest` into the wire body, applying the one
   * provider-specific quirk.
   */
  private buildBody(req: AgentCallRequest): CompatibleChatRequest {
    // GLM cannot disable thinking (notes section 3) and charges the reasoning
    // tokens to `max_tokens`, so the budget is raised for it. The headroom is
    // unconditional: `reasoning` is a hint, and a seat that did not ask for
    // reasoning still thinks — sending a disable attempt would fail the whole
    // call with a 400 (notes section 3, consequence 1).
    const maxTokens = req.maxTokens + GLM_REASONING_HEADROOM_TOKENS;

    return {
      model: req.modelId,
      messages: toSdkMessages(req.messages),
      temperature: req.temperature,
      max_tokens: maxTokens,
      stream: true,
      // Notes section 4: GLM honours this and sends a final chunk carrying
      // usage, including `completion_tokens_details.reasoning_tokens`.
      stream_options: { include_usage: true },
      // Section 8.3 rule 3: a hint. It is never load-bearing — `json.ts`
      // extracts and validates regardless of whether this is honoured.
      ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    };
  }

  /** Wrap a transport failure as a typed, classified `LLMError`. */
  private toLLMError(err: unknown): LLMError {
    if (err instanceof LLMError) return err;

    const classification = classifyError(err);
    const error = new LLMError(`[${this.provider}] ${errorMessage(err)}`, classification, err);

    logger.warn(
      {
        provider: this.provider,
        status: classification.status,
        code: classification.code,
        retryable: classification.retryable,
        err: errorMessage(err),
      },
      'llm transport failure',
    );

    return error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Section 8.3 rule 2: characters divided by four, rounded up. Deliberately
 * crude — it exists so the budget guard always receives a number, not so it
 * receives an accurate one.
 */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

function countRequestChars(req: AgentCallRequest): number {
  let chars = 0;
  for (const message of req.messages) chars += message.content.length;
  return chars;
}

/**
 * `ChatMessage` is a plain discriminated union; the SDK models the same shape
 * as a union of per-role interfaces, which a union-typed discriminant does not
 * structurally satisfy. One assertion here keeps the call site clean.
 */
function toSdkMessages(
  messages: readonly AgentCallRequest['messages'][number][],
): ChatCompletionMessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam);
}

/**
 * `prompt_tokens` / `completion_tokens` may be absent on a partial chunk, so
 * each is validated independently. `completion_tokens` already includes the
 * reasoning tokens (notes section 4) — it is not added again.
 */
function readUsage(usage: ChatCompletionChunk['usage']): ProviderUsage | null {
  if (!usage) return null;
  const tokensIn = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
  const tokensOut = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
  if (tokensIn === null && tokensOut === null) return null;
  return { tokensIn, tokensOut };
}

/**
 * Notes section 6: GLM puts a human-readable string under `error.message`
 * (sometimes nested at `error.error.message`), so one reader handles both.
 * Neither shape is retryable.
 */
function errorMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);

  const record = err as { message?: unknown; error?: { message?: unknown } };
  if (typeof record.message === 'string' && record.message.length > 0) return record.message;

  const nested = record.error?.message;
  if (typeof nested === 'string' && nested.length > 0) return nested;

  return String(err);
}
