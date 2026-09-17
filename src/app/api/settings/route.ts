import 'server-only';

import { z } from 'zod';

import { providerPresence } from '@/lib/config';
import { getDb } from '@/lib/db/client';
import { getSettingsOrDefaults, putSettings } from '@/lib/db/queries/settings';
import { listPricing, pricingUpdatedAt } from '@/lib/db/queries/pricing';
import { ok, parseBody } from '../_lib/http';

/**
 * `GET /api/settings` and `PUT /api/settings` — the non-secret runtime
 * settings, provider key PRESENCE (never values, section 6.2), and the seeded
 * pricing table with its last-checked date (Appendix C).
 */

const patchSchema = z
  .object({
    theme: z.enum(['warroom', 'hearth']).optional(),
    budgetUsd: z.number().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCalls: z.number().int().positive().optional(),
    staggerCadenceMs: z.number().int().nonnegative().optional(),
    refineEnabled: z.boolean().optional(),
    maxCritiquesPerAgent: z.number().int().min(0).optional(),
    reasoningPanelEnabled: z.boolean().optional(),
    defaultAvatarStyle: z.enum(['dicebear', 'lucide', 'initials', 'pixel']).optional(),
    temperatureBySeatClass: z
      .object({ me: z.number(), lens: z.number() })
      .optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    retries: z.number().int().nonnegative().optional(),
    concurrency: z.number().int().positive().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update.' });

export async function GET(): Promise<Response> {
  const db = getDb();
  const rows = listPricing(db);

  return ok({
    settings: getSettingsOrDefaults(db),
    providers: providerPresence(),
    pricing: rows.map((row) => ({
      provider: row.provider,
      modelId: row.modelId,
      inputPerMtokUsd: row.inputPerMtokUsd,
      outputPerMtokUsd: row.outputPerMtokUsd,
      updatedAt: row.updatedAt,
    })),
    pricingUpdatedAt: pricingUpdatedAt(db),
  });
}

export async function PUT(request: Request): Promise<Response> {
  const parsed = await parseBody(request, patchSchema);
  if (!parsed.ok) return parsed.response;

  const db = getDb();
  const settings = putSettings(db, parsed.data);
  const rows = listPricing(db);

  return ok({
    settings,
    providers: providerPresence(),
    pricing: rows.map((row) => ({
      provider: row.provider,
      modelId: row.modelId,
      inputPerMtokUsd: row.inputPerMtokUsd,
      outputPerMtokUsd: row.outputPerMtokUsd,
      updatedAt: row.updatedAt,
    })),
    pricingUpdatedAt: pricingUpdatedAt(db),
  });
}
