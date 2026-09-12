import 'server-only';

import { config } from '@/lib/config';

import { StubSearchAdapter } from './stub';
import { TavilySearchAdapter } from './tavily';
import type { SearchAdapter } from './types';

/**
 * Search adapter selection, sections 4.3 and 6.1.
 *
 * `SEARCH_PROVIDER=tavily|stub` picks the implementation. The adapter is
 * memoised because it owns a timeout policy, and the Tavily one reads its key
 * lazily inside `search()` — so calling this at boot with no key configured is
 * safe, and the missing key surfaces on the seat that actually searched.
 */

let cached: SearchAdapter | null = null;

export function getSearchAdapter(): SearchAdapter {
  if (cached) return cached;

  cached =
    config.SEARCH_PROVIDER === 'tavily' ? new TavilySearchAdapter() : new StubSearchAdapter();

  return cached;
}

/** Drop the memoised adapter. Test-only, so a suite can flip the provider. */
export function clearSearchAdapterCache(): void {
  cached = null;
}

export { SearchError, DEFAULT_MAX_RESULTS } from './types';
export type { SearchAdapter, SearchOptions, SearchResult } from './types';
export { STUB_NOTICE, StubSearchAdapter } from './stub';
export { TAVILY_SEARCH_ENDPOINT, TavilySearchAdapter } from './tavily';
