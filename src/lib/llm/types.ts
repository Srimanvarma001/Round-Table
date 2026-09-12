import type { ProviderKey } from '@/shared/constants';

/**
 * The provider-agnostic call contract, section 8.1.
 * No step module imports a vendor SDK; everything goes through `LLMAdapter`.
 */

export type DeltaKind = 'reasoning' | 'text';

export interface LLMDelta {
  kind: DeltaKind;
  text: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AgentCallRequest {
  provider: ProviderKey;
  modelId: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  /** Ask the provider for a JSON object response where it supports it. */
  jsonMode?: boolean;
  /**
   * Enable the reasoning channel where the model exposes one.
   *
   * Verified provider behaviour (2026-09-11, see docs/PROVIDER-NOTES.md):
   * glm thinking cannot be disabled at all; `glm-5.3-flash` always reasons and
   * the reasoning tokens are billed and counted against `max_tokens`, so the
   * adapter adds headroom instead of sending a thinking block.
   */
  reasoning?: boolean;
  /** Free-form label used only for logs and the reasoning drawer's title. */
  label?: string;
}

export interface AgentCallResult {
  reasoningText: string;
  contentText: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string;
  latencyMs: number;
}

export interface LLMAdapter {
  stream(req: AgentCallRequest, signal: AbortSignal): AsyncIterable<LLMDelta>;
  complete(req: AgentCallRequest, signal: AbortSignal): Promise<AgentCallResult>;
}

/** Whether a failed call is worth retrying. Section 8.3 rule 4. */
export type ErrorClassification = {
  retryable: boolean;
  /** HTTP status where one was received. */
  status?: number;
  code: string;
};

export class LLMError extends Error {
  constructor(
    message: string,
    readonly classification: ErrorClassification,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LLMError';
  }

  get retryable(): boolean {
    return this.classification.retryable;
  }
}

export class StructuredOutputError extends Error {
  readonly code = 'STRUCTURED_OUTPUT';
  constructor(
    message: string,
    readonly rawText: string,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(
    message: string,
    readonly kind: 'cost' | 'tokens' | 'calls',
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Classify a transport-level failure into retryable / not.
 * 429 and 5xx retry; every other 4xx does not; network errors do.
 */
export function classifyError(err: unknown): ErrorClassification {
  const anyErr = err as { status?: number; code?: string; name?: string; message?: string };

  const status = typeof anyErr?.status === 'number' ? anyErr.status : undefined;
  if (status !== undefined) {
    if (status === 429) return { retryable: true, status, code: 'RATE_LIMITED' };
    if (status >= 500) return { retryable: true, status, code: 'SERVER_ERROR' };
    if (status >= 400) return { retryable: false, status, code: 'CLIENT_ERROR' };
  }

  const name = anyErr?.name ?? '';
  const code = anyErr?.code ?? '';
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR/.test(code) ||
    /fetch failed|network|socket hang up/i.test(anyErr?.message ?? '')
  ) {
    return { retryable: true, status, code: code || 'NETWORK' };
  }

  return { retryable: false, status, code: code || 'UNKNOWN' };
}
