import 'server-only';

import {
  DEFAULT_CHARACTER,
  SEAT_CHARACTERS,
  isCharacterKey,
} from '@/lib/avatars/characters';
import { type Db } from '@/lib/db/client';
import { listAgents, updateAgent } from '@/lib/db/queries/agents';
import { getSetting, setSetting } from '@/lib/db/queries/settings';
import type { SeatKey } from '@/shared/constants';

/**
 * One-time migration: seats seeded before the character sprites existed still
 * carry `avatar_style: 'dicebear'` and `avatar_seed: <seat key>`. This flips
 * every such seat to the `pixel` style with its seat character (`3_knight`
 * for the Me Agent), preserving a seed that is already a character key and
 * every other column (name, lens, accent, weight, prompts).
 *
 * Gated by the `characters_migrated` settings key, so it runs exactly once per
 * database. After it, the avatar columns belong to the user and nothing on
 * boot ever rewrites them — the same guarantee the seed script gives.
 */

const MIGRATION_KEY = 'characters_migrated';

/** The character a seat key defaults to; unknown (custom) seats get the shared fallback. */
function seatDefaultCharacter(seatKey: string): string {
  return SEAT_CHARACTERS[seatKey as SeatKey] ?? DEFAULT_CHARACTER;
}

/**
 * Flip every seat not already on the `pixel` style to its character sprite.
 * Returns how many seats were changed; 0 when already migrated (or when the
 * database has no seats yet, which still marks the gate as done — the seed
 * script inserts `pixel` seats on a fresh database anyway).
 */
export function migrateSeatsToCharacters(db: Db): number {
  if (getSetting<boolean>(db, MIGRATION_KEY) === true) return 0;

  let changed = 0;
  for (const row of listAgents(db)) {
    if (row.avatarStyle === 'pixel') continue;
    updateAgent(db, row.id, {
      avatarStyle: 'pixel',
      avatarSeed: isCharacterKey(row.avatarSeed) ? row.avatarSeed : seatDefaultCharacter(row.seatKey),
      // Pixel sprites are static files; the cache is meaningless and the
      // client resolves `/characters/<seed>.png` from `avatarSeed`.
      avatarSvgCache: null,
    });
    changed += 1;
  }

  setSetting(db, MIGRATION_KEY, true);
  return changed;
}
