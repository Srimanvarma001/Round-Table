import { describe, expect, it } from 'vitest';

import {
  computeProfileDiff,
  isPreserved,
  mergeProfile,
  normaliseLabel,
  type ExtractedItemLike,
  type ProfileItemLike,
} from '@/lib/profile/merge';
import {
  AUTHOR_BRIEF_WORD_CAP,
  type ProfileItemKind,
} from '@/shared/constants';
import {
  countWords,
  renderAuthorBrief,
  renderProfileViews,
  renderSummaryText,
} from '@/lib/profile/summary';

let seq = 0;

function stored(
  overrides: Partial<ProfileItemLike> & { kind: ProfileItemKind; label: string },
): ProfileItemLike {
  seq += 1;
  return {
    id: `item-${seq}`,
    kind: overrides.kind,
    label: overrides.label,
    detail: overrides.detail ?? 'Some supporting detail.',
    source: overrides.source ?? 'github',
    confidence: overrides.confidence ?? 0.9,
    locked: overrides.locked ?? false,
    stale: overrides.stale ?? false,
    orderIndex: overrides.orderIndex ?? seq,
  };
}

function extracted(
  overrides: Partial<ExtractedItemLike> & { kind: ProfileItemKind; label: string },
): ExtractedItemLike {
  return {
    kind: overrides.kind,
    label: overrides.label,
    detail: overrides.detail ?? 'Fresh extracted detail.',
    source: overrides.source ?? 'github',
    confidence: overrides.confidence ?? 0.85,
  };
}

describe('mergeProfile', () => {
  it('copies locked and manual items through untouched', () => {
    const locked = stored({ kind: 'skill', label: 'TypeScript', locked: true, detail: 'Mine, do not touch.' });
    const manual = stored({ kind: 'goal', label: 'Ship weekly', source: 'manual' });
    const result = mergeProfile([locked, manual], [extracted({ kind: 'skill', label: 'TypeScript', detail: 'Changed!' })]);

    const keptLocked = result.items.find((i) => i.label === 'TypeScript');
    expect(keptLocked?.detail).toBe('Mine, do not touch.');
    expect(result.items.find((i) => i.label === 'Ship weekly')?.source).toBe('manual');
  });

  it('updates matched generated items in place, preserving order_index', () => {
    const existing = stored({ kind: 'skill', label: 'TypeScript', orderIndex: 3 });
    const result = mergeProfile([existing], [extracted({ kind: 'skill', label: 'typescript  ' })]);
    const updated = result.items.find((i) => i.id === existing.id);
    expect(updated).toBeDefined();
    expect(updated?.detail).toBe('Fresh extracted detail.');
    expect(updated?.orderIndex).toBe(3);
  });

  it('hides removed generated items instead of deleting them', () => {
    const existing = stored({ kind: 'skill', label: 'COBOL' });
    const result = mergeProfile([existing], [extracted({ kind: 'skill', label: 'TypeScript' })]);
    const hidden = result.items.find((i) => i.label === 'COBOL');
    expect(hidden).toBeDefined();
    expect(hidden?.stale).toBe(true);
  });

  it('matches labels case-insensitively and across punctuation', () => {
    expect(normaliseLabel('  TypeScript!! ')).toBe(normaliseLabel('typescript'));
  });

  it('preserved items are exactly the locked-or-manual ones', () => {
    expect(isPreserved({ source: 'manual', locked: false })).toBe(true);
    expect(isPreserved({ source: 'github', locked: true })).toBe(true);
    expect(isPreserved({ source: 'github', locked: false })).toBe(false);
  });
});

describe('computeProfileDiff', () => {
  it('reports added, changed and removed with a preserved count', () => {
    const before = [
      stored({ kind: 'skill', label: 'TypeScript' }),
      stored({ kind: 'skill', label: 'COBOL' }),
      stored({ kind: 'goal', label: 'Ship weekly', source: 'manual' }),
    ];
    const after = mergeProfile(before, [extracted({ kind: 'skill', label: 'TypeScript', detail: 'New words.' })]);
    const diff = computeProfileDiff(before, after.items);
    expect(diff.preserved).toBeGreaterThanOrEqual(1);
    expect(diff.removed.map((r) => r.label)).toContain('COBOL');
  });
});

describe('summary rendering', () => {
  const items = [
    stored({ kind: 'skill', label: 'TypeScript', detail: 'Five years, production systems.' }),
    stored({ kind: 'constraint', label: 'Weekends only', detail: 'Two hours on Saturdays.' }),
    stored({ kind: 'anti_pattern', label: 'Abandoned side projects', detail: 'Twelve repos untouched for a year.' }),
    stored({ kind: 'project', label: 'Plant CLI', detail: 'A CLI that nags you to water plants.' }),
  ];

  it('is deterministic: same items in any order give the same text', () => {
    const a = renderProfileViews(items);
    const b = renderProfileViews([...items].reverse());
    expect(a.summaryText).toBe(b.summaryText);
    expect(a.authorBrief).toBe(b.authorBrief);
  });

  it('the full summary covers every kind; the brief covers four kinds only', () => {
    const views = renderProfileViews(items);
    expect(views.summaryText).toContain('Plant CLI');
    expect(views.authorBrief).not.toContain('Plant CLI');
    expect(views.authorBrief).toContain('TypeScript');
    expect(views.authorBrief).toContain('Weekends only');
  });

  it('the brief stays under the 400-word cap even for a huge profile', () => {
    const huge: ProfileItemLike[] = [];
    for (let i = 0; i < 60; i++) {
      huge.push(
        stored({
          kind: (['skill', 'constraint', 'anti_pattern', 'goal'] as ProfileItemKind[])[i % 4] as ProfileItemKind,
          label: `Item number ${i}`,
          detail: `This is a long supporting sentence with many words to push the total up. `.repeat(8),
        }),
      );
    }
    const brief = renderAuthorBrief(huge);
    expect(countWords(brief)).toBeLessThanOrEqual(AUTHOR_BRIEF_WORD_CAP);
  });

  it('marks inferred items so the Me Agent knows what is a guess', () => {
    const text = renderSummaryText([
      stored({ kind: 'taste', label: 'Minimalist CLIs', source: 'inferred', confidence: 0.62 }),
    ]);
    expect(text).toContain('inferred');
  });
});
