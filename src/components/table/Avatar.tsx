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
 * Avatar system: wax-seal medallions, never photographic faces.
 *
 * Every style renders as a solid object sitting on the felt: an accent fill
 * with an embossed ring and a drop shadow (the `chip-disc` layer in themes.css
 * supplies the shadow and inset highlight). Three styles, selectable per seat:
 *  1. `dicebear` — abstract generative geometry, deterministic from a seed,
 *     generated on the SERVER and cached. Mounted inside the medallion frame.
 *  2. `lucide`   — one persona glyph stamped into the wax.
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
  const frame = {
    width: size,
    height: size,
    opacity: dimmed ? 0.4 : 1,
    // Wax body: accent lit from above, darkened at the edge, with the
    // embossed ring highlight from the chip-ring parent.
    background: `radial-gradient(circle at 50% 32%, color-mix(in srgb, ${accent} 62%, var(--text) 8%), color-mix(in srgb, ${accent} 78%, var(--bg) 22%) 68%, color-mix(in srgb, ${accent} 55%, var(--bg) 45%))`,
  } as const;

  if (style === 'dicebear' && svg) {
    // The SVG is server-generated from a trusted, deterministic seed; it is
    // never derived from user-supplied HTML. It sits inside the wax frame as
    // the seal device, darkened slightly so the ring stays dominant.
    return (
      <div
        aria-hidden="true"
        className="flex items-center justify-center overflow-hidden rounded-[var(--radius-pill)]"
        style={frame}
      >
        <div
          aria-hidden="true"
          className="flex items-center justify-center overflow-hidden rounded-[var(--radius-pill)]"
          style={{ width: size * 0.78, height: size * 0.78, filter: 'brightness(0.94) saturate(0.9)' }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    );
  }

  if (style === 'lucide') {
    const Icon = SEAT_ICONS[iconName] ?? UserRound;
    return (
      <div
        aria-hidden="true"
        className="flex items-center justify-center rounded-[var(--radius-pill)]"
        style={frame}
      >
        <span
          className="flex items-center justify-center rounded-[var(--radius-pill)]"
          style={{
            width: size * 0.62,
            height: size * 0.62,
            background: 'color-mix(in srgb, var(--bg) 42%, transparent)',
            boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5), 0 1px 0 rgba(236,230,217,0.14)',
          }}
        >
          <Icon style={{ width: size * 0.34, height: size * 0.34, color: 'var(--text)' }} strokeWidth={1.75} />
        </span>
      </div>
    );
  }

  // `initials` — also the fallback when SVG generation failed.
  const monogram = monogramFor(name);
  return (
    <div
      aria-hidden="true"
      className="display-face flex items-center justify-center rounded-[var(--radius-pill)]"
      style={{
        ...frame,
        color: 'var(--bg)',
        fontSize: size * 0.34,
        fontWeight: 700,
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size * 0.62,
          height: size * 0.62,
          borderRadius: 'var(--radius-pill)',
          background: 'rgba(236, 230, 217, 0.2)',
          boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.4)',
        }}
      >
        {monogram}
      </span>
    </div>
  );
}

export function monogramFor(name: string): string {
  const words = name.replace(/^the\s+/i, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
