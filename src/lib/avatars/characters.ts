import type { SeatKey } from '@/shared/constants';

/**
 * Character avatars, served from `public/characters/`.
 *
 * The 8 PNGs live in `public/characters/`, so Next.js serves them at
 * `/characters/*.png`. `avatarStyle: 'pixel'` + `avatarSeed: <character key>`
 * selects one.
 */

export const CHARACTER_KEYS = [
  '1_pirate',
  '1_knight',
  '2_fairy',
  '2_knight',
  '2_pirate',
  '3_fairy',
  '3_knight',
  '3_pirate',
] as const;

export type CharacterKey = (typeof CHARACTER_KEYS)[number];

const CHARACTER_SET: ReadonlySet<string> = new Set<string>(CHARACTER_KEYS);

export function isCharacterKey(value: string | null | undefined): value is CharacterKey {
  return CHARACTER_SET.has((value ?? '').trim().toLowerCase());
}

/** Public URL for a character key. */
export function characterImageFor(key: string | null | undefined): string {
  const normalised = (key ?? '').trim().toLowerCase();
  if (isCharacterKey(normalised)) return `/characters/${normalised}.png`;
  return `/characters/${DEFAULT_CHARACTER}.png`;
}

/**
 * Default seat -> character assignment.
 * `3_knight` is the Me Agent, per owner request. The rest are matched to the
 * seat lens: pirates for the trader/attacker/scout seats, knights for the
 * grounded/structural seats, fairies for the playful/wise seats.
 */
export const SEAT_CHARACTERS: Record<SeatKey, CharacterKey> = {
  seat_me: '3_knight',
  seat_pragmatist: '1_knight',
  seat_wildcard: '2_fairy',
  seat_market_analyst: '1_pirate',
  seat_technical_architect: '2_knight',
  seat_contrarian: '3_pirate',
  seat_mentor: '3_fairy',
  seat_trend_watcher: '2_pirate',
};

export const DEFAULT_CHARACTER: CharacterKey = '1_knight';

/**
 * Resolve the image URL for a seat. A stored character key wins; otherwise
 * fall back to the seat-key default so legacy rows (seed === seat_key) still
 * render a sensible sprite when switched to the `pixel` style.
 */
export function seatCharacterImage(
  avatarSeed: string | null | undefined,
  seatKey?: string | null,
): string {
  const normalised = (avatarSeed ?? '').trim().toLowerCase();
  if (isCharacterKey(normalised)) return `/characters/${normalised}.png`;
  if (seatKey && seatKey in SEAT_CHARACTERS) {
    return `/characters/${SEAT_CHARACTERS[seatKey as SeatKey]}.png`;
  }
  return `/characters/${DEFAULT_CHARACTER}.png`;
}

/**
 * A random character key, never the excluded one — the avatar reroll must
 * change what is rendered, and both renders are deterministic from the seed.
 * Uses `crypto.randomUUID()` (Node 20+ and browsers) as the entropy source.
 */
export function randomCharacterKey(exclude?: string | null): CharacterKey {
  const excluded = (exclude ?? '').trim().toLowerCase();
  const pool = CHARACTER_KEYS.filter((key) => key !== excluded);
  const chosen = pool.length > 0 ? pool : [...CHARACTER_KEYS];
  const index = Math.floor(Math.random() * chosen.length);
  return chosen[index] ?? DEFAULT_CHARACTER;
}
