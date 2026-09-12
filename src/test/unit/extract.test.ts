import { describe, expect, it } from 'vitest';

import { MockLLMAdapter } from '@/lib/llm/mock';
import {
  buildExtractionMessages,
  extractProfileItems,
  normaliseExtractedItems,
} from '@/lib/profile/extract';

/**
 * LLM extraction to items, section 10.3. The adapter is injected, so no
 * network is involved: one call per source, temperature 0.2, capped at 12
 * items, conservative on inference.
 */

const signal = new AbortController().signal;

function itemsJson(n: number, kind = 'skill', confidence = 0.85): string {
  const items = Array.from({ length: n }, (_, i) => ({
    kind,
    label: `Item ${i}`,
    detail: 'Evidence from the source text.',
    confidence,
  }));
  return JSON.stringify({ items });
}

describe('extractProfileItems', () => {
  it('extracts items with the ingestor as source', async () => {
    const adapter = new MockLLMAdapter({ script: () => itemsJson(3) });
    const result = await extractProfileItems(
      { source: 'github', text: 'repos, languages, topics' },
      { adapter },
    );
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((i) => i.source === 'github')).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('caps output at 12 items per source', async () => {
    const adapter = new MockLLMAdapter({ script: () => itemsJson(30) });
    const result = await extractProfileItems({ source: 'cv', text: 'a very long CV' }, { adapter });
    expect(result.items).toHaveLength(12);
    expect(result.droppedCount).toBeGreaterThan(0);
  });

  it('marks inferred kinds below 0.8 confidence', async () => {
    // Taste inferred from a non-notes source is a guess: source becomes
    // 'inferred' and the confidence is capped, whatever the model claimed.
    const adapter = new MockLLMAdapter({
      script: () => itemsJson(2, 'taste', 0.95),
    });
    const result = await extractProfileItems({ source: 'github', text: 'repos and topics' }, { adapter });
    expect(result.ok).toBe(true);
    for (const item of result.items) {
      expect(item.source).toBe('inferred');
      expect(item.confidence).toBeLessThan(0.8);
    }
    // Notes pass through verbatim, so their taste items are not inferences.
    const verbatim = await extractProfileItems(
      { source: 'notes', text: 'taste notes' },
      { adapter },
    );
    expect(verbatim.items.every((i) => i.source === 'notes')).toBe(true);
  });

  it('returns ok:false with warnings when the model produces nothing usable', async () => {
    const adapter = new MockLLMAdapter({ script: () => 'no json here at all' });
    const result = await extractProfileItems({ source: 'cv', text: 'x' }, { adapter });
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('builds the prompt with the source text and a context steer', () => {
    const messages = buildExtractionMessages({
      source: 'local_scan',
      text: 'package.json, pyproject.toml',
      context: 'folders: plant-cli',
    });
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.content).join('\n')).toContain('plant-cli');
  });
});

describe('normaliseExtractedItems', () => {
  it('dedupes by normalised label and drops overlong speculation', () => {
    const { items, droppedCount } = normaliseExtractedItems(
      [
        { kind: 'skill', label: 'TypeScript', detail: 'd', confidence: 0.9 },
        { kind: 'skill', label: 'typescript ', detail: 'dup', confidence: 0.9 },
        { kind: 'skill', label: '', detail: 'empty label', confidence: 0.9 },
      ],
      'github',
    );
    expect(items.map((i) => i.label)).toEqual(['TypeScript']);
    expect(droppedCount).toBe(2);
  });

  it('drops empty fields and warns about the count', () => {
    const { items, warnings, droppedCount } = normaliseExtractedItems(
      [
        { kind: 'skill', label: 'TypeScript', detail: 'Production use.', confidence: 0.9 },
        { kind: 'skill', label: 'Hollow', detail: '   ', confidence: 0.9 },
      ],
      'github',
    );
    expect(items.map((i) => i.label)).toEqual(['TypeScript']);
    expect(droppedCount).toBe(1);
    expect(warnings.join(' ')).toContain('1 item(s) dropped');
  });

  void signal;
});
