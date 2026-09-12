import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  BANNED_STYLES,
  DICEBEAR_STYLE_KEYS,
  dicebearStyleFor,
  isBannedStyle,
  renderSeatAvatar,
} from '@/lib/avatars/dicebear';

/**
 * Avatar generation and theme tokens, sections 16.3, 16.4 and 16.8.
 *
 * - The same seed renders byte-identical SVG; different seeds differ.
 * - The resolved style is always abstract: the banned realistic families can
 *   never be selected, and an unknown request falls back to the default.
 * - Generation never throws a seat into a missing-avatar state: a failure
 *   degrades to initials.
 * - Both theme token sets define the same key list.
 * - Every seat accent clears 3:1 against the table surface it sits on.
 */

function seatSvg(seed: string): string {
  return renderSeatAvatar({
    style: 'dicebear',
    seed,
    accent: '#F0B429',
    name: 'The Pragmatist',
    iconName: 'hammer',
  });
}

describe('avatar generation', () => {
  it('is deterministic for the same seed', () => {
    expect(seatSvg('seat_pragmatist')).toBe(seatSvg('seat_pragmatist'));
  });

  it('differs across seats', () => {
    expect(seatSvg('seat_pragmatist')).not.toBe(seatSvg('seat_wildcard'));
  });

  it('bans every realistic style, with the neutral variants too', () => {
    for (const banned of BANNED_STYLES) {
      expect(isBannedStyle(banned)).toBe(true);
    }
    expect(isBannedStyle('avataaars')).toBe(true);
    expect(isBannedStyle('personas')).toBe(true);
    // The generative set and the banned set never overlap.
    for (const key of DICEBEAR_STYLE_KEYS) {
      expect(isBannedStyle(key)).toBe(false);
    }
  });

  it('narrows unknown or banned requests to the abstract default', () => {
    expect(dicebearStyleFor('avataaars')).toBe('shapes');
    expect(dicebearStyleFor('nonsense')).toBe('shapes');
    expect(dicebearStyleFor(null)).toBe('shapes');
    expect(dicebearStyleFor('rings')).toBe('rings');
  });

  it('always returns markup, degrading to initials rather than throwing', () => {
    const svg = renderSeatAvatar({
      style: 'definitely-not-a-style',
      seed: 'seat_me',
      accent: '#F0B429',
      name: 'You',
      iconName: 'user-round',
    });
    expect(svg).toContain('<svg');
    expect(seatSvg('x')).toContain('<svg');
  });
});

type ThemeVars = Record<string, string>;

function readThemeVars(): { warroom: ThemeVars; hearth: ThemeVars } {
  const css = fs.readFileSync(
    path.join(process.cwd(), 'src', 'styles', 'themes.css'),
    'utf8',
  );
  const blocks = [...css.matchAll(/:root\[data-theme='(\w+)'\]\s*\{([^}]*)\}/g)];
  const out: Record<string, ThemeVars> = {};
  for (const [, theme, body] of blocks) {
    const vars: ThemeVars = {};
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      vars[name] = value.trim();
    }
    // The warroom selector appears twice (`:root,` + themed); merge, first wins.
    out[theme] = { ...vars, ...(out[theme] ?? {}) };
  }
  if (!out.warroom || !out.hearth) throw new Error('both theme blocks must exist');
  return { warroom: out.warroom, hearth: out.hearth };
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const rgb = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('theme tokens', () => {
  it('both token sets define the same key list', () => {
    const { warroom, hearth } = readThemeVars();
    expect(Object.keys(hearth).sort()).toEqual(Object.keys(warroom).sort());
  });

  it('both themes define all eight seat accents', () => {
    const { warroom, hearth } = readThemeVars();
    for (let n = 1; n <= 8; n++) {
      expect(warroom[`--seat-${n}`]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(hearth[`--seat-${n}`]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('every accent clears 3:1 against its theme table surface', () => {
    const { warroom, hearth } = readThemeVars();
    for (const [themeName, vars] of [['warroom', warroom], ['hearth', hearth]] as const) {
      for (let n = 1; n <= 8; n++) {
        const ratio = contrastRatio(vars[`--seat-${n}`], vars['--table-mid']);
        expect(
          ratio,
          `${themeName} --seat-${n} (${vars[`--seat-${n}`]}) vs --table-mid (${vars['--table-mid']}): ${ratio.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
