import {
  DEFAULT_MAX_RESULTS,
  type SearchAdapter,
  type SearchOptions,
  type SearchResult,
} from './types';

/**
 * Canned search results for offline development, section 5.
 *
 * THIS IS STUB DATA. It is not a search engine, it does not reach the network,
 * and every result says so in its title and URL. It exists so the Trend-Watcher
 * seat produces a citation-shaped input with `SEARCH_PROVIDER=stub` (section
 * 6.1) and so integration tests are hermetic and reproducible.
 *
 * Results are a deterministic function of the query: the same query always
 * returns the same hits in the same order, which is what makes a recorded
 * fixture a valid assertion.
 *
 * Deliberately no `server-only`: it is safe to import anywhere.
 */

/** Marks every field of every stub hit as fabricated. */
export const STUB_NOTICE = '[STUB DATA]';

/** Reserved TLD, guaranteed never to resolve. Visible in the UI as a stub URL. */
const STUB_URL_PREFIX = 'https://stub.invalid';

/**
 * Fabricated sources. Named after the kind of page the Trend-Watcher would
 * actually cite so the seat's prompt formatting is exercised realistically.
 */
const STUB_SOURCES = [
  { name: 'Signal Roundup', kind: 'trend report' },
  { name: 'Practitioner Survey', kind: 'community poll' },
  { name: 'Tooling Landscape', kind: 'market map' },
  { name: 'Field Notes', kind: 'engineering blog' },
  { name: 'Adoption Tracker', kind: 'usage statistics' },
  { name: 'Design Systems Review', kind: 'comparative review' },
] as const;

export class StubSearchAdapter implements SearchAdapter {
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const requested = Math.max(1, Math.min(opts.maxResults ?? DEFAULT_MAX_RESULTS, STUB_SOURCES.length));
    const offset = fnv1a(trimmed) % STUB_SOURCES.length;

    const results: SearchResult[] = [];
    for (let i = 0; i < requested; i += 1) {
      const source = STUB_SOURCES[(offset + i) % STUB_SOURCES.length];
      results.push({
        title: `${STUB_NOTICE} ${source.name}: ${trimmed}`,
        url: `${STUB_URL_PREFIX}/${slug(trimmed)}#${i + 1}`,
        content:
          `${STUB_NOTICE} Fabricated ${source.kind} entry for the query "${trimmed}". ` +
          'This text exists only so offline runs and integration tests have a deterministic ' +
          'search-shaped input. It is not a real source and must never be cited as one.',
        score: Number((1 - i * 0.1).toFixed(2)),
      });
    }

    return results;
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'query'
  );
}

/** FNV-1a, 32-bit. Deterministic across runs and processes. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
