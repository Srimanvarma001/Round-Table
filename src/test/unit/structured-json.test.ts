import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  REPAIR_INSTRUCTION,
  callWithStructuredOutput,
  extractJsonObject,
  parseStructured,
  selectStructuredText,
} from '@/lib/llm/json';
import { MockLLMAdapter } from '@/lib/llm/mock';
import { StructuredOutputError, type AgentCallRequest } from '@/lib/llm/types';

const schema = z.object({
  proposals: z.array(z.object({ title: z.string(), description: z.string() })),
});

function request(): AgentCallRequest {
  return {
    provider: 'mock',
    modelId: 'mock',
    messages: [{ role: 'user', content: 'propose' }],
    temperature: 0.5,
    maxTokens: 800,
    jsonMode: true,
    label: 'json-test',
  };
}

const GOOD = JSON.stringify({ proposals: [{ title: 'Plant CLI', description: 'A CLI that nags you to water plants.' }] });

describe('extractJsonObject', () => {
  it('returns clean JSON unchanged', () => {
    expect(extractJsonObject(GOOD)).toBe(GOOD);
  });

  it('extracts JSON wrapped in prose', () => {
    const text = `Here is the result you asked for: ${GOOD} Hope that helps!`;
    expect(extractJsonObject(text)).toBe(GOOD);
  });

  it('extracts JSON inside a fenced code block without fence stripping', () => {
    const text = ['```json', GOOD, '```'].join('\n');
    expect(extractJsonObject(text)).toBe(GOOD);
  });

  it('ignores braces inside string values', () => {
    const tricky = JSON.stringify({ proposals: [{ title: 'a } tricky { title', description: 'x' }] });
    expect(extractJsonObject(`prefix ${tricky} suffix`)).toBe(tricky);
  });

  it('returns null when there is no object at all', () => {
    expect(extractJsonObject('just words, no braces')).toBeNull();
  });

  it('returns null for truncated JSON (finish_reason length case)', () => {
    expect(extractJsonObject('{"proposals": [{"title": "cut off here"')).toBeNull();
  });
});

describe('parseStructured', () => {
  it('validates a good payload', () => {
    expect(parseStructured(GOOD, schema)).toEqual(JSON.parse(GOOD));
  });

  it('throws StructuredOutputError carrying the raw text on schema mismatch', () => {
    const bad = JSON.stringify({ proposals: [{ title: 42 }] });
    try {
      parseStructured(bad, schema);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredOutputError);
      expect((err as StructuredOutputError).rawText).toBe(bad);
    }
  });
});

describe('selectStructuredText', () => {
  it('prefers the content channel', () => {
    expect(
      selectStructuredText({
        contentText: GOOD,
        reasoningText: 'draft thinking',
        tokensIn: 1,
        tokensOut: 1,
        finishReason: 'stop',
        latencyMs: 1,
      }),
    ).toBe(GOOD);
  });

  it('falls back to the reasoning channel only when content is empty', () => {
    expect(
      selectStructuredText({
        contentText: '   ',
        reasoningText: GOOD,
        tokensIn: 1,
        tokensOut: 1,
        finishReason: 'stop',
        latencyMs: 1,
      }),
    ).toBe(GOOD);
  });
});

describe('callWithStructuredOutput', () => {
  const signal = new AbortController().signal;

  it('returns the first attempt when it validates', async () => {
    const adapter = new MockLLMAdapter({ script: () => GOOD });
    const out = await callWithStructuredOutput(adapter, request(), schema, signal);
    expect(out.attempts).toBe(1);
    expect(out.value).toEqual(JSON.parse(GOOD));
    expect(adapter.calls).toHaveLength(1);
  });

  it('repairs once: a bad first reply plus the corrective message yields a good second', async () => {
    const seen: string[][] = [];
    const adapter = new MockLLMAdapter({
      script: (ctx) => {
        seen.push(ctx.request.messages.map((m) => m.content));
        return ctx.attempt === 1 ? 'not json at all' : GOOD;
      },
    });
    const out = await callWithStructuredOutput(adapter, request(), schema, signal);
    expect(out.attempts).toBe(2);
    expect(out.value).toEqual(JSON.parse(GOOD));
    // The repair retry echoes the bad reply and appends the corrective message.
    const repairMessages = seen[1] ?? [];
    expect(repairMessages).toContain('not json at all');
    expect(repairMessages[repairMessages.length - 1]).toBe(REPAIR_INSTRUCTION);
  });

  it('truncated JSON is repaired on retry (the length finish_reason case)', async () => {
    const adapter = new MockLLMAdapter({
      script: (ctx) => (ctx.attempt === 1 ? '{"proposals": [{"title": "cut' : GOOD),
    });
    const out = await callWithStructuredOutput(adapter, request(), schema, signal);
    expect(out.attempts).toBe(2);
  });

  it('two consecutive failures raise StructuredOutputError and never a third call', async () => {
    const adapter = new MockLLMAdapter({ script: () => 'still not json' });
    await expect(callWithStructuredOutput(adapter, request(), schema, signal)).rejects.toBeInstanceOf(
      StructuredOutputError,
    );
    expect(adapter.calls).toHaveLength(2);
  });
});
