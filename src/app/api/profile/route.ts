import 'server-only';

import { getDb } from '@/lib/db/client';
import { getActiveProfile, listProfileItems, listIngestRuns } from '@/lib/db/queries/profile';
import { currentUserId, ok, toProfileDTO, toProfileItemDTO } from '../_lib/http';

/**
 * `GET /api/profile` — the active profile, its items and the ingestion history
 * (section 14).
 */

export async function GET(): Promise<Response> {
  const db = getDb();
  const profile = getActiveProfile(db);
  const items = profile
    ? listProfileItems(db, profile.id)
    : [];

  return ok({
    profile: profile ? toProfileDTO(profile) : null,
    items: items.map(toProfileItemDTO),
    ingestRuns: listIngestRuns(db, 20),
  });
}
