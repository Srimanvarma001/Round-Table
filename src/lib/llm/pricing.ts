import type { ModelPricingRow } from '@/lib/db/schema';

/**
 * Token price table and cost estimation, sections 8.1 and 17.2.
 *
 * The budget guard is only as accurate as this table, so the figures below are
 * the seed values for the editable `model_pricing` rows (section 7.12): the
 * settings page shows their `updatedAt` and allows a manual edit, per
 * Appendix C. A stale row under-reports cost rather than failing a run, which
 * is why the `/settings` page surfaces the date.
 */

/**
 * 2026-09-11T00:00:00Z.
 *
 * The date the figures below were checked against the providers' published
 * price lists (docs/PROVIDER-NOTES.md section 7). Kept as a literal so a
 * seeded row and a comment can never disagree, and so the value does not
 * depend on the host clock or timezone at import time.
 */
export const PRICING_CHECKED_AT = 1_789_084_800_000;

/** Human-readable form of `PRICING_CHECKED_AT`, for the settings screen. */
export const PRICING_CHECKED_AT_ISO = '2026-09-11';

/** A price row. Structurally identical to `model_pricing` in lib/db/schema.ts. */
export type PricingRow = ModelPricingRow;

/**
 * Per-million-token USD prices, checked 2026-09-11.
 *
 * Only the models the seeded seat assignment actually uses (notes section 1)
 * are listed. GLM's flash tier is priced far below its reasoning-heavy tiers
 * because thinking tokens are billed as ordinary completion tokens there,
 * which is the same quirk the adapter compensates for with
 * `GLM_REASONING_HEADROOM_TOKENS`.
 */
export const DEFAULT_PRICING: readonly PricingRow[] = [
  {
    provider: 'glm',
    modelId: 'glm-5.3-flash',
    inputPerMtokUsd: 0.1,
    outputPerMtokUsd: 0.3,
    updatedAt: PRICING_CHECKED_AT,
  },
];

/** What a call is billed on. Token counts come from the adapter, section 8.1. */
export interface CostInput {
  provider: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
}

/**
 * `(tokensIn × inputPerMtok + tokensOut × outputPerMtok) / 1e6`.
 *
 * An unknown model costs **zero**, not an exception: a seat can be pointed at
 * a model that has not been priced yet, and section 17.5 requires a run to
 * degrade rather than die. Zero is visible in the reveal payload's cost
 * metric, where a thrown error would be a dead run.
 */
export function estimateCostUsd(input: CostInput, priceRows: readonly PricingRow[] = DEFAULT_PRICING): number {
  const row = findPricingRow(input.provider, input.modelId, priceRows);
  if (!row) return 0;

  const tokensIn = Number.isFinite(input.tokensIn) ? Math.max(0, input.tokensIn) : 0;
  const tokensOut = Number.isFinite(input.tokensOut) ? Math.max(0, input.tokensOut) : 0;

  const cost = (tokensIn / 1_000_000) * row.inputPerMtokUsd + (tokensOut / 1_000_000) * row.outputPerMtokUsd;
  // Guard against a NaN leaking out of a hand-edited price row.
  return Number.isFinite(cost) ? cost : 0;
}

/** Exact match on `(provider, modelId)`; the table's primary key. */
export function findPricingRow(
  provider: string,
  modelId: string,
  priceRows: readonly PricingRow[] = DEFAULT_PRICING,
): PricingRow | undefined {
  return priceRows.find((row) => row.provider === provider && row.modelId === modelId);
}

/** Round a cost for display without pretending to more precision than there is. */
export function formatCostUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
