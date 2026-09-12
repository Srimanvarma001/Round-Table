import { describe, expect, it } from 'vitest';

import { providerPresence } from '@/lib/config';
import { estimateCostUsd, findPricingRow, formatCostUsd } from '@/lib/llm/pricing';
import { clearAdapterCache, getAdapter, getMockAdapter } from '@/lib/llm/registry';
import { MissingProviderKeyError } from '@/lib/config';
import { MockLLMAdapter } from '@/lib/llm/mock';
import { estimateTokensFromChars } from '@/lib/llm/openai-compatible';
import { refineTaskKey, taskKey, taskKeyPrefix } from '@/lib/orchestrator/taskKey';
import { cn, formatDateTime, formatDuration, formatUsd, humanise, truncate } from '@/lib/utils';

/**
 * Small pure modules: cost math, idempotency keys, formatting, and the
 * adapter registry's call-time (never import-time) key resolution.
 */

describe('pricing math', () => {
  const rows = [
    { provider: 'glm', modelId: 'glm-5.3-flash', inputPerMtokUsd: 0.1, outputPerMtokUsd: 0.3, updatedAt: 1 },
  ];

  it('bills per-million-token prices and prices unknown models at zero', () => {
    expect(
      estimateCostUsd({ provider: 'glm', modelId: 'glm-5.3-flash', tokensIn: 1_000_000, tokensOut: 1_000_000 }, rows),
    ).toBeCloseTo(0.4, 12);
    // Unknown models degrade to zero, never throw (section 17.5).
    expect(estimateCostUsd({ provider: 'glm', modelId: 'nope', tokensIn: 999, tokensOut: 999 }, rows)).toBe(0);
    expect(findPricingRow('glm', 'glm-5.3-flash', rows)?.outputPerMtokUsd).toBe(0.3);
    expect(findPricingRow('glm', 'nope', rows)).toBeUndefined();
  });

  it('formats costs without false precision', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
    expect(formatCostUsd(0.0048)).toBe('$0.0048');
    expect(formatCostUsd(1.5)).toBe('$1.50');
  });

  it('estimates stream tokens at characters over four', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(8)).toBe(2);
  });
});

describe('task keys', () => {
  it('builds the section-11.6 format and rejects ambiguous parts', () => {
    expect(taskKey({ runId: 'r', step: 'propose', agentId: 'a', round: 1 })).toBe(
      'run:r:step:propose:agent:a:round:1:attempt-agnostic',
    );
    expect(refineTaskKey({ runId: 'r', step: 'refine', agentId: 'a', round: 1, proposalId: 'p' })).toContain(
      'target:p',
    );
    expect(taskKeyPrefix('r', 'vote')).toBe('run:r:step:vote:');
    expect(() => taskKey({ runId: 'r', step: 'propose', agentId: 'a:b', round: 1 })).toThrow();
    expect(() => taskKey({ runId: 'r', step: 'propose', agentId: 'a', round: 0 })).toThrow();
  });
});

describe('registry', () => {
  it('memoises the mock and throws MissingProviderKeyError at call time', () => {
    clearAdapterCache();
    expect(getMockAdapter()).toBe(getMockAdapter());
    expect(getMockAdapter()).toBeInstanceOf(MockLLMAdapter);
    // No GLM key in this environment: the app still boots (import worked),
    // and only an actual generation attempt fails.
    expect(() => getAdapter('glm')).toThrow(MissingProviderKeyError);
    clearAdapterCache();
  });
});

describe('config presence', () => {
  it('reports key presence, never values', () => {
    const presence = providerPresence();
    expect(typeof presence.glm.configured).toBe('boolean');
    expect(typeof presence.glm.baseUrl).toBe('string');
    expect(JSON.stringify(presence)).not.toContain('cbb397a6');
  });
});

describe('formatting utils', () => {
  it('formats dates, durations, money, names and truncation', () => {
    expect(formatUsd(0.0048)).toBe('$0.0048');
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(NaN)).toBe('$0.00');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(null)).toBe('—');
    expect(humanise('seat_me')).toBe('Seat Me');
    expect(truncate('hello world', 5)).toBe('hell…');
    expect(truncate('hi', 5)).toBe('hi');
    expect(formatDateTime(Date.now())).toBeTruthy();
    expect(formatDateTime(null)).toBe('—');
    expect(cn('a', false && 'b', 'c')).toBe('a c');
  });
});
