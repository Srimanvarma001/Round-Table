import 'server-only';

import { config } from '@/lib/config';
import { getDb } from '@/lib/db/client';
import { modelPricing, type ModelPricingRow } from '@/lib/db/schema';
import { DEFAULT_PRICING, estimateCostUsd, type PricingRow } from '@/lib/llm/pricing';
import { BudgetExceededError } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import type { ProviderKey } from '@/shared/constants';

/**
 * The run budget guard, section 17.2.
 *
 * > `BudgetGuard` increments counters after every call and checks before
 * > dispatching the next task. [...] **The guard checks before dispatching,
 * > never mid-call**, so no partial result is ever orphaned.
 *
 * That sentence fixes the whole design of this class:
 *
 *  - `check()` is called by the scheduler immediately before a task is handed
 *    to a worker and throws `BudgetExceededError` when any limit is reached. A
 *    task that is not dispatched cannot produce an orphaned half-result, and a
 *    call already in flight is never cancelled by the guard — the scheduler
 *    drains in-flight work and only then reports the overrun.
 *  - `record()` is called by the engine once a call has settled, success or
 *    failure, because a failed call still consumed tokens.
 *
 * ## The 80 percent warning
 *
 * `record()` returns a `BudgetWarning` **exactly once**, the first time the
 * cost ratio reaches 80 percent of the limit, and `null` on every other call.
 * The engine publishes it as `budget.warning` (section 13.3) and does nothing
 * else with it. Returning the indicator rather than taking an emit callback
 * keeps this class free of any dependency on the bus, which is what lets it be
 * unit-tested on its own; the trade-off is that a caller who ignores the
 * return value silently loses the banner, so `record()` says so in its doc.
 *
 * Counters are seeded from the `runs` row on resume, so a paused-and-resumed
 * run cannot spend its budget twice (section 11.4 rule 4).
 */

export interface BudgetLimits {
  costUsd: number;
  tokens: number;
  calls: number;
}

export interface BudgetUsage {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  calls: number;
}

export interface BudgetWarning {
  usedUsd: number;
  limitUsd: number;
  pct: number;
}

export interface BudgetLimitSource {
  budgetUsd?: number | null;
  maxTokens?: number | null;
  maxCalls?: number | null;
}

/**
 * Section 17.2: "Limits: `RUN_BUDGET_USD`, `RUN_MAX_TOKENS`, `RUN_MAX_CALLS`".
 * The run's own `config_snapshot` wins when it carries a value; otherwise the
 * environment default from `lib/config` applies.
 */
export function budgetLimitsFrom(source: BudgetLimitSource = {}): BudgetLimits {
  return {
    costUsd: positiveOr(source.budgetUsd, config.RUN_BUDGET_USD),
    tokens: positiveOr(source.maxTokens, config.RUN_MAX_TOKENS),
    calls: positiveOr(source.maxCalls, config.RUN_MAX_CALLS),
  };
}

function positiveOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Section 17.2's warning threshold. */
export const BUDGET_WARNING_PCT = 0.8;

/** A settled call, as the engine reports it to the guard. */
export interface BudgetUsageDelta {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  calls?: number;
}

export class BudgetGuard {
  private usage: BudgetUsage;

  private warned = false;

  constructor(
    readonly limits: BudgetLimits,
    initial: Partial<BudgetUsage> = {},
  ) {
    this.usage = {
      costUsd: finite(initial.costUsd),
      tokensIn: finite(initial.tokensIn),
      tokensOut: finite(initial.tokensOut),
      calls: finite(initial.calls),
    };
  }

  /** Total tokens billed so far, in and out (section 17.2's `RUN_MAX_TOKENS`). */
  get tokens(): number {
    return this.usage.tokensIn + this.usage.tokensOut;
  }

  get current(): Readonly<BudgetUsage> {
    return { ...this.usage };
  }

  /** Fraction of the cost limit consumed, clamped to `[0, 1]` for display. */
  get costPct(): number {
    if (this.limits.costUsd <= 0) return 0;
    return Math.min(1, this.usage.costUsd / this.limits.costUsd);
  }

  /**
   * The pre-dispatch gate. Throws `BudgetExceededError` when a limit has been
   * reached, naming which one, so the engine can set the matching
   * `error_code` and keep every completed artefact (section 17.2).
   *
   * Comparison is `>=`, not `>`: one more call would take the run past the
   * limit, and this is the only moment at which the run can be stopped without
   * orphaning a result.
   */
  check(): void {
    const { costUsd, calls } = this.usage;
    const tokens = this.tokens;

    if (costUsd >= this.limits.costUsd) {
      throw new BudgetExceededError(
        `Run cost limit reached: $${costUsd.toFixed(4)} of $${this.limits.costUsd.toFixed(2)}`,
        'cost',
      );
    }
    if (tokens >= this.limits.tokens) {
      throw new BudgetExceededError(
        `Run token limit reached: ${tokens} of ${this.limits.tokens} tokens`,
        'tokens',
      );
    }
    if (calls >= this.limits.calls) {
      throw new BudgetExceededError(
        `Run call limit reached: ${calls} of ${this.limits.calls} calls`,
        'calls',
      );
    }
  }

  /**
   * Record a settled call.
   *
   * @returns the `budget.warning` payload the first time the cost crosses 80
   *          percent of the limit, `null` otherwise. Callers that ignore this
   *          value knowingly give up the warning banner.
   */
  record(delta: BudgetUsageDelta): BudgetWarning | null {
    this.usage.tokensIn += finite(delta.tokensIn);
    this.usage.tokensOut += finite(delta.tokensOut);
    this.usage.costUsd += finite(delta.costUsd);
    this.usage.calls += delta.calls ?? 1;

    if (this.warned) return null;
    if (this.limits.costUsd <= 0) return null;
    if (this.usage.costUsd < this.limits.costUsd * BUDGET_WARNING_PCT) return null;

    this.warned = true;
    return {
      usedUsd: this.usage.costUsd,
      limitUsd: this.limits.costUsd,
      pct: this.costPct,
    };
  }
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * `(provider, modelId, tokensIn, tokensOut) -> USD`.
 *
 * The rows come from `model_pricing` when it has been seeded, falling back to
 * `lib/llm/pricing`'s baked-in table so a run still budgets correctly before
 * the seed script has run (Appendix C: "the budget guard is only as accurate
 * as that table").
 */
export type CostEstimator = (input: {
  provider: ProviderKey;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
}) => number;

export function makeCostEstimator(priceRows?: readonly PricingRow[]): CostEstimator {
  const rows = priceRows && priceRows.length > 0 ? priceRows : loadPricingRows();
  return (input) =>
    estimateCostUsd(
      {
        provider: input.provider,
        modelId: input.modelId,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
      },
      rows,
    );
}

/**
 * The editable price table (section 7.12). Read once per run rather than per
 * call, so a mid-run edit on `/settings` cannot make the arithmetic of a
 * single run inconsistent.
 *
 * Never throws: an unreadable table degrades to the baked-in seed rows, and a
 * missing `model_pricing` row prices at zero — visible in the run's cost
 * metric (Appendix C) rather than fatal.
 */
export function loadPricingRows(): readonly PricingRow[] {
  try {
    const rows: ModelPricingRow[] = getDb().select().from(modelPricing).all();
    return rows.length > 0 ? rows : DEFAULT_PRICING;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'model_pricing read failed; using the baked-in price table',
    );
    return DEFAULT_PRICING;
  }
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
