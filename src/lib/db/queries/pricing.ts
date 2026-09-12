import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';

import type { Db } from '@/lib/db/client';
import { nowMs } from '@/lib/db/client';
import { modelPricing, type ModelPricingRow } from '@/lib/db/schema';

/**
 * The token price table, section 7.12 and Appendix C.
 *
 * Seeded by `scripts/seed.ts` with the checked-on dates recorded there. The
 * budget guard (section 17.2) is only as accurate as this table, which is why
 * `/settings` shows `pricingUpdatedAt` and allows a manual edit.
 *
 * The cost arithmetic itself belongs to `lib/llm/pricing.ts`, not here: this
 * module only reads and writes rows.
 *
 * Drizzle's better-sqlite3 driver is synchronous: no `await` anywhere here.
 */

export type ModelPricingInsert = typeof modelPricing.$inferInsert;

/** `updated_at` is stamped by these helpers, never supplied by a caller. */
export type PricingCreateInput = Omit<ModelPricingInsert, 'updatedAt'>;

export function listPricing(db: Db): ModelPricingRow[] {
  return db
    .select()
    .from(modelPricing)
    .orderBy(asc(modelPricing.provider), asc(modelPricing.modelId))
    .all();
}

export function getPricing(
  db: Db,
  provider: string,
  modelId: string,
): ModelPricingRow | undefined {
  return db
    .select()
    .from(modelPricing)
    .where(and(eq(modelPricing.provider, provider), eq(modelPricing.modelId, modelId)))
    .get();
}

/** Insert or replace one model's prices. The composite PK is the conflict target. */
export function upsertPricing(db: Db, values: PricingCreateInput): ModelPricingRow {
  const updated = db
    .insert(modelPricing)
    .values({ ...values, updatedAt: nowMs() })
    .onConflictDoUpdate({
      target: [modelPricing.provider, modelPricing.modelId],
      set: {
        inputPerMtokUsd: values.inputPerMtokUsd,
        outputPerMtokUsd: values.outputPerMtokUsd,
        updatedAt: nowMs(),
      },
    })
    .returning()
    .get();
  if (!updated) throw new Error('model_pricing upsert did not persist');
  return updated;
}

/** Seed-time bulk write. One transaction, so a partial price table never exists. */
export function upsertPricingMany(
  db: Db,
  rows: readonly PricingCreateInput[],
): number {
  if (rows.length === 0) return 0;
  return db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(modelPricing)
        .values({ ...row, updatedAt: nowMs() })
        .onConflictDoUpdate({
          target: [modelPricing.provider, modelPricing.modelId],
          set: {
            inputPerMtokUsd: row.inputPerMtokUsd,
            outputPerMtokUsd: row.outputPerMtokUsd,
            updatedAt: nowMs(),
          },
        })
        .run();
    }
    return rows.length;
  });
}

/**
 * When the price table was last touched, or null when it is empty. Section 14
 * surfaces this on `/settings` next to the cost estimate it feeds.
 */
export function pricingUpdatedAt(db: Db): number | null {
  const row = db
    .select({ max: sql<number | null>`max(${modelPricing.updatedAt})` })
    .from(modelPricing)
    .get();
  return row?.max ?? null;
}
