import { describe, expect, it } from 'vitest';

import {
  BUDGET_WARNING_PCT,
  BudgetGuard,
  budgetLimitsFrom,
  type BudgetLimits,
} from '@/lib/orchestrator/budget';
import { BudgetExceededError } from '@/lib/llm/types';

const LIMITS: BudgetLimits = { costUsd: 1.0, tokens: 1000, calls: 10 };

describe('BudgetGuard', () => {
  it('starts clean: check() passes with zero usage', () => {
    const guard = new BudgetGuard(LIMITS);
    expect(() => guard.check()).not.toThrow();
    expect(guard.costPct).toBe(0);
    expect(guard.tokens).toBe(0);
  });

  it('returns the 80% warning exactly once, on the crossing call', () => {
    const guard = new BudgetGuard(LIMITS);

    expect(guard.record({ tokensIn: 10, tokensOut: 10, costUsd: 0.5 })).toBeNull();
    const warning = guard.record({ tokensIn: 10, tokensOut: 10, costUsd: 0.3 });
    expect(warning).not.toBeNull();
    expect(warning?.usedUsd).toBeCloseTo(0.8, 12);
    expect(warning?.limitUsd).toBe(1.0);
    expect(warning?.pct).toBeCloseTo(0.8, 12);

    // Once warned, never again — even past the limit.
    expect(guard.record({ tokensIn: 10, tokensOut: 10, costUsd: 0.5 })).toBeNull();
  });

  it('does not warn below 80 percent', () => {
    const guard = new BudgetGuard(LIMITS);
    const justUnder = LIMITS.costUsd * BUDGET_WARNING_PCT - 0.001;
    expect(guard.record({ tokensIn: 1, tokensOut: 1, costUsd: justUnder })).toBeNull();
  });

  it('aborts exactly at each limit, not after (comparison is >=)', () => {
    const cost = new BudgetGuard(LIMITS);
    cost.record({ tokensIn: 0, tokensOut: 0, costUsd: 1.0 });
    expect(() => cost.check()).toThrow(BudgetExceededError);

    const tokens = new BudgetGuard(LIMITS);
    tokens.record({ tokensIn: 600, tokensOut: 400, costUsd: 0 });
    expect(() => tokens.check()).toThrow(BudgetExceededError);

    const calls = new BudgetGuard(LIMITS);
    for (let i = 0; i < 10; i++) calls.record({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    expect(() => calls.check()).toThrow(BudgetExceededError);
  });

  it('names the breached limit so the engine sets the matching error code', () => {
    const guard = new BudgetGuard(LIMITS);
    for (let i = 0; i < 10; i++) guard.record({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    try {
      guard.check();
      expect.unreachable('check() should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as BudgetExceededError).kind).toBe('calls');
      expect((err as BudgetExceededError).code).toBe('BUDGET_EXCEEDED');
    }
  });

  it('checks before dispatch: usage just under every limit still passes', () => {
    const guard = new BudgetGuard(LIMITS);
    guard.record({ tokensIn: 499, tokensOut: 500, costUsd: 0.999, calls: 9 });
    expect(() => guard.check()).not.toThrow();
  });

  it('seeds counters from the runs row so a resume cannot spend twice', () => {
    const guard = new BudgetGuard(LIMITS, { costUsd: 0.5, tokensIn: 100, tokensOut: 200, calls: 4 });
    expect(guard.tokens).toBe(300);
    expect(guard.current.calls).toBe(4);
    expect(guard.costPct).toBeCloseTo(0.5, 12);
  });

  it('counts failed calls too: record() defaults to one call', () => {
    const guard = new BudgetGuard(LIMITS);
    guard.record({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    expect(guard.current.calls).toBe(1);
  });
});

describe('budgetLimitsFrom', () => {
  it('prefers the run snapshot over the environment defaults', () => {
    const limits = budgetLimitsFrom({ budgetUsd: 2.5, maxTokens: 5000, maxCalls: 20 });
    expect(limits).toEqual({ costUsd: 2.5, tokens: 5000, calls: 20 });
  });

  it('falls back per field when the snapshot carries no value', () => {
    const limits = budgetLimitsFrom({});
    expect(limits.costUsd).toBeGreaterThan(0);
    expect(limits.tokens).toBeGreaterThan(0);
    expect(limits.calls).toBeGreaterThan(0);
  });

  it('rejects non-positive snapshot values in favour of the defaults', () => {
    const defaults = budgetLimitsFrom({});
    const limits = budgetLimitsFrom({ budgetUsd: -1, maxTokens: 0, maxCalls: NaN });
    expect(limits).toEqual(defaults);
  });
});
