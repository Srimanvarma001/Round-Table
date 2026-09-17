import 'server-only';

import { createAvatar } from '@dicebear/core';
import { glass, rings, shapes } from '@dicebear/collection';

import type { AvatarStyle } from '@/shared/constants';

/**
 * Avatar rendering, section 16.3.
 *
 * Four styles, stored per seat in `agents.avatar_style`:
 *   `dicebear` (default)  — abstract generative geometry from `@dicebear/*`
 *   `lucide`              — one persona icon in an accent-tinted circle
 *   `initials`            — two-letter monogram, also the degradation path
 *   `pixel`               — pixel-art sprite from `public/characters/`,
 *                         resolved client-side, needs no SVG generation
 *
 * HARD RULE (section 16.3): no photographic faces and no realistic human
 * illustration. The table is a council of lenses, not eight people. The
 * realistic DiceBear styles are banned and `resolveAvatarStyle()` can never
 * return one, whatever the database or a request body asks for.
 *
 * This module is server-only by design (section 16.3: "Generation happens on
 * the server, never in the browser, so the dependency stays out of the client
 * bundle"). The client receives finished SVG markup, cached in
 * `agents.avatar_svg_cache`.
 */

// ---------------------------------------------------------------------------
// Style table
// ---------------------------------------------------------------------------

/**
 * The generative styles used by the `dicebear` avatar style. All three are
 * abstract: shape geometry, concentric rings, and screen-blended glass forms.
 */
export const STYLES = { shapes, rings, glass } as const;

export type DicebearStyleKey = keyof typeof STYLES;

export const DICEBEAR_STYLE_KEYS: readonly DicebearStyleKey[] = ['shapes', 'rings', 'glass'];

/** Section 16.3's default generative style. */
export const DEFAULT_DICEBEAR_STYLE: DicebearStyleKey = 'shapes';

/**
 * Banned by section 16.3, with the `-neutral` variants of the same generators
 * listed too: the neutral variants are still recognisably depictions of a
 * person, so the ban covers them.
 */
export const BANNED_STYLES = [
  'avataaars',
  'avataaars-neutral',
  'personas',
  'notionists',
  'notionists-neutral',
  'adventurer',
  'adventurer-neutral',
] as const;

export type BannedStyle = (typeof BANNED_STYLES)[number];

const BANNED_SET: ReadonlySet<string> = new Set<string>(BANNED_STYLES);

/** True for a banned realistic style. Case-insensitive. */
export function isBannedStyle(style: string | null | undefined): boolean {
  return BANNED_SET.has((style ?? '').trim().toLowerCase());
}

/** Narrow a requested generative sub-style, rejecting banned and unknown names. */
export function dicebearStyleFor(requested: string | null | undefined): DicebearStyleKey {
  const normalised = (requested ?? '').trim().toLowerCase();
  return (DICEBEAR_STYLE_KEYS as readonly string[]).includes(normalised)
    ? (normalised as DicebearStyleKey)
    : DEFAULT_DICEBEAR_STYLE;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Avatar edge length in px, fixed by section 16.3 so the cache is canonical. */
export const AVATAR_SIZE = 128;

/** Options the spec fixes for every generative render. */
export const SPEC_AVATAR_OPTIONS: { backgroundColor: string[]; shape2Color: string[] } = {
  // Transparent: the seat ring supplies the colour field, not the avatar.
  backgroundColor: [],
  shape2Color: ['transparent'],
};

/**
 * `rings` declares `ringColor` in its style schema, not `shape1Color`, so the
 * spec's option set leaves a rings avatar in DiceBear's default palette with
 * the seat accent unused. One extra option per style is what makes the accent
 * actually land; the spec's `shape1Color` / `shape2Color` / `shape3Color` set
 * is passed unchanged for `shapes`.
 *
 * `glass` declares no shape colour option at all (only `backgroundColor`): its
 * glyph is drawn with `mix-blend-mode: screen` and is designed to sit over a
 * coloured field, so it takes the seat ring's colour rather than the accent.
 */
function colorOptionsFor(style: DicebearStyleKey, accent: string): Record<string, string[]> {
  switch (style) {
    case 'shapes':
      return { shape1Color: [accent], shape2Color: ['transparent'], shape3Color: [accent] };
    case 'rings':
      return { ringColor: [accent] };
    case 'glass':
      return {};
  }
}

/**
 * Render one generative avatar. Transparent background, accent-tinted
 * geometry, deterministic from the seed (section 16.3). The seed is
 * `agents.avatar_seed`, so the same seat always renders the same shape.
 */
export function renderAvatarSvg(opts: {
  style: DicebearStyleKey;
  seed: string;
  accent: string;
}): string {
  const style = dicebearStyleFor(opts.style);
  const options = {
    seed: opts.seed,
    size: AVATAR_SIZE,
    ...SPEC_AVATAR_OPTIONS,
    ...colorOptionsFor(style, opts.accent),
  };

  // A switch rather than an indexed lookup: `createAvatar` is generic over the
  // style's option type, and each style must be instantiated with its own.
  switch (style) {
    case 'shapes':
      return createAvatar(shapes, options).toString();
    case 'rings':
      return createAvatar(rings, options).toString();
    case 'glass':
      return createAvatar(glass, options).toString();
  }
}

// ---------------------------------------------------------------------------
// Style resolution
// ---------------------------------------------------------------------------

/**
 * The style a seat should actually render with. Never returns a banned style,
 * whatever is stored or posted.
 *
 * `requested` is normally `agents.avatar_style`; anything unrecognised falls
 * back to the default. A banned value is treated as a refusal and degrades all
 * the way to `initials`. When `dicebear` is selected the generator is probed
 * once with the seat's seed, and a throw degrades to `initials` — section 16.3:
 * "Never leave a seat without an avatar."
 */
export function resolveAvatarStyle(
  requested: string | null | undefined,
  seatSeed: string,
): AvatarStyle {
  const normalised = (requested ?? '').trim().toLowerCase();

  if (isBannedStyle(normalised)) return 'initials';
  if (normalised === 'lucide') return 'lucide';
  if (normalised === 'initials') return 'initials';
  if (normalised === 'pixel') return 'pixel';

  try {
    renderAvatarSvg({ style: DEFAULT_DICEBEAR_STYLE, seed: seatSeed, accent: PROBE_ACCENT });
    return 'dicebear';
  } catch {
    return 'initials';
  }
}

/** Probe colour: the accent is irrelevant to whether generation succeeds. */
const PROBE_ACCENT = '#000000';

// ---------------------------------------------------------------------------
// Fallbacks that need no dependency
// ---------------------------------------------------------------------------

/** Escape text destined for an SVG text node or attribute. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Two-letter monogram for a seat name: the initials of the first two words, or
 * the first two letters of a single word. "The Market Analyst" becomes "TM".
 */
export function monogramFor(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Style 3, `initials`: a two-letter monogram in the seat accent. Used for a
 * new unconfigured seat and as the degradation path when generation fails.
 *
 * Drawn with plain SVG text — no font dependency and no network call — so it
 * can never fail.
 */
export function renderInitials(name: string, accent: string): string {
  const monogram = escapeXml(monogramFor(name));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" role="img">`,
    `<circle cx="50" cy="50" r="50" fill="${escapeXml(accent)}" fill-opacity="0.12"/>`,
    `<text x="50" y="50" fill="${escapeXml(accent)}" font-family="ui-sans-serif, system-ui, sans-serif"`,
    ` font-size="38" font-weight="600" letter-spacing="1" text-anchor="middle" dominant-baseline="central">`,
    monogram,
    '</text>',
    '</svg>',
  ].join('');
}

/**
 * Style 2, `lucide`: one persona icon in an accent-tinted circle. Zero
 * generation cost and the fastest to read at a glance.
 *
 * The glyph paths are local stand-ins for the lucide icons named in the
 * section 16.3 table: `lucide-react` is a client dependency and must not be
 * pulled into this server module. The client component renders the real icon
 * when it has the component available; this SVG is what gets cached and
 * serialised.
 */
const LUCIDE_GLYPHS: Record<string, string> = {
  // head and shoulders
  'user-round': '<circle cx="12" cy="7.6" r="3.6"/><path d="M5.4 20.2a6.6 6.6 0 0 1 13.2 0"/>',
  // head on a shaft
  hammer: '<path d="M13.4 8.6 4.8 17.2l2 2 8.6-8.6"/><path d="M14.6 3.4l6 6-2.6 2.6-6-6z"/>',
  // two dice
  dices: '<rect x="3.5" y="3.5" width="10" height="10" rx="2"/><rect x="10.5" y="10.5" width="10" height="10" rx="2"/><path d="M6.6 6.6h.01M10.4 10.4h.01M13.6 13.6h.01M17.4 17.4h.01"/>',
  // rising line
  'trending-up': '<path d="M3.5 16.5l5-5 3.5 3.5 7-7"/><path d="M14.5 8h4.5v4.5"/>',
  // stacked blocks
  blocks: '<rect x="3.5" y="12.5" width="8" height="8" rx="1.5"/><rect x="12.5" y="12.5" width="8" height="8" rx="1.5"/><rect x="8" y="3.5" width="8" height="8" rx="1.5"/>',
  // crossed blades
  swords: '<path d="M4 4l9.5 9.5"/><path d="M20 4l-9.5 9.5"/><path d="M6.8 15.2 4 18l2 2 2.8-2.8"/><path d="M17.2 15.2 20 18l-2 2-2.8-2.8"/>',
  // needle in a dial
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.4 8.6l-2 4.8-4.8 2 2-4.8z"/>',
  // sweep and blip
  radar: '<path d="M12 12 5.6 5.6"/><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/><path d="M12 7.5a4.5 4.5 0 1 0 4.5 4.5"/><circle cx="12" cy="12" r="1.2"/>',
};

/** Neutral glyph for any icon name this module has no stand-in for. */
const FALLBACK_GLYPH = '<circle cx="12" cy="12" r="3.4"/>';

export function renderLucideAvatar(iconName: string, accent: string): string {
  const glyph = LUCIDE_GLYPHS[iconName] ?? FALLBACK_GLYPH;
  const tint = escapeXml(accent);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}"`,
    ` data-icon="${escapeXml(iconName)}" fill="none" stroke="${tint}" stroke-width="5.2"`,
    ' stroke-linecap="round" stroke-linejoin="round" role="img">',
    `<circle cx="50" cy="50" r="50" fill="${tint}" fill-opacity="0.12"/>`,
    `<g transform="translate(26 26) scale(2)">${glyph}</g>`,
    '</svg>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Single entry point
// ---------------------------------------------------------------------------

export interface SeatAvatarInput {
  /** `agents.avatar_style`, as stored. Validated here, never trusted. */
  style: string | null | undefined;
  /** `agents.avatar_seed`, defaulting to the seat key. */
  seed: string;
  /** `agents.accent_color`, or the theme token's resolved hex. */
  accent: string;
  /** `agents.name`, for the monogram. */
  name: string;
  /** `agents.icon_name`, for the lucide style. */
  iconName: string;
  /** Optional generative sub-style; defaults to `shapes`. */
  dicebearStyle?: string | null;
}

/**
 * Render the avatar for a seat in whichever style it resolves to. Always
 * returns markup: if the generative path throws, the seat degrades to the
 * monogram rather than rendering nothing (section 16.3).
 */
export function renderSeatAvatar(input: SeatAvatarInput): string {
  const style = resolveAvatarStyle(input.style, input.seed);

  if (style === 'lucide') return renderLucideAvatar(input.iconName, input.accent);

  // Pixel sprites are static files resolved client-side; nothing to generate
  // or cache. An empty cache keeps the row honest: the client renders
  // `/characters/<seed>.png` from `avatarSeed`.
  if (style === 'pixel') return '';

  if (style === 'dicebear') {
    try {
      return renderAvatarSvg({
        style: dicebearStyleFor(input.dicebearStyle),
        seed: input.seed,
        accent: input.accent,
      });
    } catch {
      return renderInitials(input.name, input.accent);
    }
  }

  return renderInitials(input.name, input.accent);
}
