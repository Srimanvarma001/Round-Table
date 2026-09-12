import 'server-only';

import { z } from 'zod';

import { getDb } from '@/lib/db/client';
import { activateProfile, getProfile, listProfileItems } from '@/lib/db/queries/profile';
import { currentUserId, fail, ok, parseBody, toProfileDTO } from '../../_lib/http';

/**
 * `POST /api/profile/apply` — promote a draft to active and archive whatever
 * was active before (section 10.4 rule 4). Activation is the explicit,
 * separate, user-confirmed step.
 */

const applySchema = z.object({ draftId: z.string().min(1) });

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(request, applySchema);
  if (!parsed.ok) return parsed.response;
  const { draftId } = parsed.data;
  const db = getDb();

  const draft = getProfile(db, draftId);
  if (!draft) return fail('NOT_FOUND', `Draft ${draftId} does not exist.`, 404);
  if (draft.userId !== currentUserId()) return fail('NOT_FOUND', `Draft ${draftId} does not exist.`, 404);
  if (draft.status !== 'draft') {
    return fail('INVALID_TRANSITION', `Profile ${draftId} is ${draft.status}, not a draft.`, 409);
  }

  const itemRows = listProfileItems(db, draftId);
  if (itemRows.length === 0) {
    return fail('EMPTY_PROFILE', 'The draft has no items; refusing to activate an empty profile.', 409);
  }

  const activated = activateProfile(db, draftId);
  if (!activated) return fail('INTERNAL', 'Activation failed; nothing changed.', 500);

  return ok({ profile: toProfileDTO(activated) });
}
