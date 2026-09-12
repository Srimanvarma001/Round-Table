import { describe, expect, it } from 'vitest';

import {
  estimateTokens,
  renderCritiqueLines,
  renderDigest,
  renderScorePattern,
  truncateToChars,
  type DigestItem,
} from '@/lib/orchestrator/digest';

function item(id: string, rank: number, bodyLen = 400): DigestItem {
  return {
    id,
    heading: `Heading ${id}`,
    body: `Body of ${id}. `.repeat(Math.ceil(bodyLen / 12)),
    notes: [`note for ${id}`],
    rank,
  };
}

describe('estimateTokens / truncateToChars', () => {
  it('estimates characters over four, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('cuts at a word boundary', () => {
    const cut = truncateToChars('alpha beta gamma delta', 12);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/ $/);
    expect('alpha beta gamma delta'.startsWith(cut.replace(/…$/, ''))).toBe(true);
  });
});

describe('renderDigest', () => {
  it('fits the token budget and reports what it dropped', () => {
    const items = [item('a', 0), item('b', 1), item('c', 2)];
    // A budget of 8 tokens holds two heading-only items; the third is dropped.
    const out = renderDigest(items, 8);
    expect(out.tokensUsed).toBeLessThanOrEqual(8);
    expect(out.includedIds.length + out.droppedIds.length).toBe(3);
    expect(out.droppedIds).toEqual(['c']);
  });

  it('always retains the leader, degrading it in place on a tiny budget', () => {
    const items = [item('winner', 0), item('loser', 1)];
    const out = renderDigest(items, 8);
    expect(out.includedIds).toContain('winner');
    expect(out.includedIds[0]).toBe('winner');
    expect(out.degraded).toBeGreaterThan(0);
  });

  it('renders best-first: the lowest rank comes first', () => {
    const items = [item('z-last', 5), item('a-first', 0)];
    const out = renderDigest(items, 10_000);
    expect(out.includedIds[0]).toBe('a-first');
    expect(out.text.indexOf('Heading a-first')).toBeLessThan(out.text.indexOf('Heading z-last'));
  });

  it('is deterministic for the same input regardless of order', () => {
    const forward = [item('a', 1), item('b', 1), item('c', 2)];
    const backward = [...forward].reverse();
    expect(renderDigest(forward, 10_000).text).toBe(renderDigest(backward, 10_000).text);
  });

  it('an empty list renders an empty digest', () => {
    const out = renderDigest([], 100);
    expect(out.text).toBe('');
    expect(out.includedIds).toEqual([]);
  });
});

describe('renderCritiqueLines / renderScorePattern', () => {
  it('renders one line per critique inside the budget', () => {
    const out = renderCritiqueLines(
      [
        { stance: 'attack', seatName: 'Contrarian', comment: 'The onboarding is the whole product.' },
        { stance: 'support', seatName: 'Mentor', comment: 'A visible finish line.' },
      ],
      200,
    );
    expect(out.includedIds).toHaveLength(2);
    expect(out.text).toContain('[attack] Contrarian');
  });

  it('renders the reveal score pattern, and names the empty case', () => {
    expect(renderScorePattern([])).toBe('no votes were cast');
    expect(
      renderScorePattern([
        { seatName: 'Pragmatist', score: 7 },
        { seatName: 'Wildcard', score: 9 },
      ]),
    ).toBe('Pragmatist 7, Wildcard 9');
  });
});
