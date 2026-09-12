import 'server-only';

import { z } from 'zod';

import { getDb } from '@/lib/db/client';
import {
  getActiveProfile,
  insertProfileItem,
  listProfileItems,
} from '@/lib/db/queries/profile';
import { fail, ok, parseBody, toProfileItemDTO } from '../../_lib/http';

/**
 * `POST /api/profile/items` — manual entry (section 14). Manual items are born
 * locked-able but unlocked; they survive every regeneration (section 10.4).
 */

const createSchema = z.object({
  kind: z.enum(['skill', 'project', 'taste', 'experience', 'constraint', 'goal', 'anti_pattern']),
  label: z.string().trim().min(1).max(160),
  detail: z.string().trim().max(2000).default(''),
  confidence: z.number().min(0).max(1).default(1),
  locked: z.boolean().default(false),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(request, createSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const db = getDb();

  const profile = getActiveProfile(db);
  if (!profile) {
    return fail('NO_PROFILE', 'No active profile exists yet; run the pipeline first.', 409);
  }

  const siblings = listProfileItems(db, profile.id);
  const nextOrder =
    siblings.filter((item) => item.kind === body.kind).reduce((max, item) => Math.max(max, item.orderIndex), 0) + 1;

  const item = insertProfileItem(db, {
    profileId: profile.id,
    kind: body.kind,
    label: body.label,
    detail: body.detail,
    source: 'manual',
    confidence: body.confidence,
    locked: body.locked,
    stale: false,
    orderIndex: nextOrder,
  });

  return ok({ item: toProfileItemDTO(item) }, 201);
}
