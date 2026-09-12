import 'server-only';

import { z } from 'zod';

import { getDb } from '@/lib/db/client';
import {
  deleteProfileItem,
  getActiveProfile,
  getProfileItem,
  touchProfileEdit,
  updateProfileItem,
} from '@/lib/db/queries/profile';
import { fail, ok, parseBody, toProfileItemDTO } from '../../../_lib/http';

/**
 * `PUT /api/profile/items/:id` — section 14: "Editing sets `source = 'manual'`
 * unless the caller passes `keepSource`". `DELETE` removes the item.
 */

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    kind: z.enum(['skill', 'project', 'taste', 'experience', 'constraint', 'goal', 'anti_pattern']).optional(),
    label: z.string().trim().min(1).max(160).optional(),
    detail: z.string().trim().max(2000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    locked: z.boolean().optional(),
    stale: z.boolean().optional(),
    orderIndex: z.number().int().min(0).optional(),
    keepSource: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update.' });

export async function PUT(request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const parsed = await parseBody(request, patchSchema);
  if (!parsed.ok) return parsed.response;
  const { keepSource, ...patch } = parsed.data;
  const db = getDb();

  const existing = getProfileItem(db, id);
  if (!existing) return fail('NOT_FOUND', `Profile item ${id} does not exist.`, 404);

  const updated = updateProfileItem(db, id, {
    ...patch,
    // The contract: a human edit makes it a manual fact, unless the caller
    // explicitly keeps the original provenance (e.g. the lock toggle).
    source: keepSource ? existing.source : 'manual',
  });
  if (!updated) return fail('NOT_FOUND', `Profile item ${id} does not exist.`, 404);

  // Section 10.6: a manual edit is a real event the summary must react to.
  const profile = getActiveProfile(db);
  if (profile) touchProfileEdit(db, profile.id);

  return ok({ item: toProfileItemDTO(updated) });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const deleted = deleteProfileItem(getDb(), id);
  if (!deleted) return fail('NOT_FOUND', `Profile item ${id} does not exist.`, 404);
  return new Response(null, { status: 204 });
}
