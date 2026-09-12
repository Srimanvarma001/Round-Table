import { describe, expect, it, vi, afterEach } from 'vitest';
import type OpenAI from 'openai';

import fixture from '../fixtures/glm-reasoning-stream.json';
import {
  GLM_REASONING_HEADROOM_TOKENS,
  OpenAICompatibleAdapter,
  estimateTokensFromChars,
} from '@/lib/llm/openai-compatible';
import { LLMError, type AgentCallRequest } from '@/lib/llm/types';

/**
 * Provider adapter, section 8.3, against a recorded GLM stream shape
 * (docs/PROVIDER-NOTES.md sections 2–4).
 *
 * - `delta.reasoning_content` normalises into reasoning deltas (rule 1).
 * - A final usage chunk feeds the budget guard; a missing one falls back to
 *   the character estimate so the guard always has a number (rule 2).
 * - `max_tokens` carries reasoning headroom and no `thinking` block is ever
 *   sent — GLM rejects the disable attempt with a 400 (notes section 3).
 * - 429/5xx classify retryable; other 4xx do not (rule 4).
 */

interface FixtureChunk {
  choices: Array<{ delta: Record<string, string>; finish_reason: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

function chunkStream(chunks: FixtureChunk[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => {
          if (i >= chunks.length) return { done: true as const, value: undefined };
          return { done: false as const, value: chunks[i++] };
        },
      };
    },
  };
}

function fakeClient(chunks: FixtureChunk[] | Error, seen?: { body?: unknown }) {
  return {
    chat: {
      completions: {
        create: vi.fn(async (body: unknown) => {
          if (seen) seen.body = body;
          if (chunks instanceof Error) throw chunks;
          return chunkStream(chunks);
        }),
      },
    },
  } as unknown as OpenAI;
}

function request(): AgentCallRequest {
  return {
    provider: 'glm',
    modelId: 'glm-5.3-flash',
    messages: [{ role: 'user', content: 'Propose two ideas.' }],
    temperature: 0.7,
    maxTokens: 600,
    jsonMode: true,
    reasoning: true,
    label: 'adapter-test',
  };
}

function adapterFor(chunks: FixtureChunk[] | Error, seen?: { body?: unknown }) {
  return new OpenAICompatibleAdapter({
    provider: 'glm',
    apiKey: 'test-key',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    client: fakeClient(chunks, seen),
  });
}

const signal = new AbortController().signal;

describe('GLM reasoning stream', () => {
  it('classifies reasoning_content and content into separate channels, in order', async () => {
    const adapter = adapterFor(fixture.chunks as FixtureChunk[]);
    const deltas = [];
    for await (const delta of adapter.stream(request(), signal)) deltas.push(delta);

    expect(deltas.filter((d) => d.kind === 'reasoning').map((d) => d.text).join('')).toBe(
      "Reading the brief through this seat's lens.",
    );
    expect(deltas.filter((d) => d.kind === 'text').map((d) => d.text).join('')).toContain(
      '"title": "Sprout Log"',
    );
    // Reasoning precedes content, as on the wire.
    expect(deltas[0]?.kind).toBe('reasoning');
  });

  it('uses the provider usage block for the budget guard', async () => {
    const adapter = adapterFor(fixture.chunks as FixtureChunk[]);
    const result = await adapter.complete(request(), signal);
    expect(result.tokensIn).toBe(812);
    expect(result.tokensOut).toBe(96);
    expect(result.finishReason).toBe('stop');
    expect(result.reasoningText).toContain('Reading the brief');
  });

  it('falls back to the character estimate when usage is absent', async () => {
    const chunks: FixtureChunk[] = [
      { choices: [{ delta: { content: '{"a": 1}' }, finish_reason: 'stop' }] },
    ];
    const adapter = adapterFor(chunks);
    const result = await adapter.complete(request(), signal);
    expect(result.tokensIn).toBe(estimateTokensFromChars('Propose two ideas.'.length));
    expect(result.tokensOut).toBe(estimateTokensFromChars('{"a": 1}'.length));
  });

  it('adds reasoning headroom to max_tokens and never sends a thinking block', async () => {
    const seen: { body?: unknown } = {};
    const adapter = adapterFor(fixture.chunks as FixtureChunk[], seen);
    await adapter.complete(request(), signal);
    const body = seen.body as Record<string, unknown>;
    expect(body.max_tokens).toBe(600 + GLM_REASONING_HEADROOM_TOKENS);
    expect(body).not.toHaveProperty('thinking');
    expect(body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' },
    });
  });

  it('classifies 429 as retryable and 400 as not', async () => {
    const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
    const badRequest = Object.assign(new Error('bad model'), { status: 400 });

    const retryable = await adapterFor(rateLimited)
      .complete(request(), signal)
      .catch((err: unknown) => err);
    expect(retryable).toBeInstanceOf(LLMError);
    expect((retryable as LLMError).retryable).toBe(true);

    const fatal = await adapterFor(badRequest)
      .complete(request(), signal)
      .catch((err: unknown) => err);
    expect(fatal).toBeInstanceOf(LLMError);
    expect((fatal as LLMError).retryable).toBe(false);
  });

  it('rejects a provider mismatch rather than sending another key', async () => {
    const adapter = adapterFor(fixture.chunks as FixtureChunk[]);
    await expect(
      adapter.complete({ ...request(), provider: 'mock' }, signal),
    ).rejects.toBeInstanceOf(LLMError);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
