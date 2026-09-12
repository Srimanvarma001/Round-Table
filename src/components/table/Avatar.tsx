'use client';

import {
  Blocks,
  Compass,
  Dices,
  Hammer,
  Radar,
  Swords,
  TrendingUp,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

import type { AvatarStyle } from '@/shared/constants';

/**
 * Avatar system, section 16.3.
 *
 * Hard rule: no photographic faces, no realistic human illustration, no style
 * that implies a person. The table is a council of lenses, not eight people.
 *
 * Three styles, selectable per seat:
 *  1. `dicebear` — abstract generative geometry, deterministic from a seed,
 *     generated on the SERVER and cached in `agents.avatar_svg_cache`. The
 *     dependency therefore stays out of the client bundle.
 *  2. `lucide`   — one persona icon in an accent-tinted circle.
 *  3. `initials` — two-letter monogram. Also the graceful degradation when SVG
 *     generation fails. Never leave a seat without an avatar.
 */

// Explicit map rather than `import * as Icons` — the wildcard form defeats
// tree-shaking and pulls the entire icon set into the client bundle.
export const SEAT_ICONS: Record<string, LucideIcon> = {
  'user-round': UserRound,
  hammer: Hammer,
  dices: Dices,
  'trending-up': TrendingUp,
  blocks: Blocks,
  swords: Swords,
  compass: Compass,
  radar: Radar,
};

export interface AvatarProps {
  style: AvatarStyle;
  /** Server-generated SVG markup, only for the `dicebear` style. */
  svg: string | null;
  iconName: string;
  name: string;
  accent: string;
  size?: number;
  /** Rendered at 40% opacity for the `disabled` seat state. */
  dimmed?: boolean;
}

export function Avatar({
  style,
  svg,
  iconName,
  name,
  accent,
  size = 44,
  dimmed = false,
}: AvatarProps) {
  const styleObj = {
    width: size,
    height: size,
    opacity: dimmed ? 0.4 : 1,
  } as const;

  if (style === 'dicebear' && svg) {
    // The SVG is server-generated from a trusted, deterministic seed; it is
    // never derived from user-supplied HTML.
    return (
      <div
        aria-hidden="true"
        className="flex items-center justify-center overflow-hidden rounded-[var(--radius-pill)]"
        style={styleObj}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  if (style === 'lucide') {
    const Icon = SEAT_ICONS[iconName] ?? UserRound;
    return (
      <div
        aria-hidden="true"
        className="flex items-center justify-center rounded-[var(--radius-pill)]"
        style={{ ...styleObj, background: `color-mix(in srgb, ${accent} 16%, transparent)` }}
      >
        <Icon style={{ width: size * 0.5, height: size * 0.5, color: accent }} strokeWidth={1.75} />
      </div>
    );
  }

  // `initials` — also the fallback when SVG generation failed.
  const monogram = monogramFor(name);
  return (
    <div
      aria-hidden="true"
      className="flex items-center justify-center rounded-[var(--radius-pill)] font-semibold"
      style={{
        ...styleObj,
        background: `color-mix(in srgb, ${accent} 16%, transparent)`,
        color: accent,
        fontSize: size * 0.36,
      }}
    >
      {monogram}
    </div>
  );
}

export function monogramFor(name: string): string {
  const words = name.replace(/^the\s+/i, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
