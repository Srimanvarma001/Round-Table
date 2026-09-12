/**
 * Web search contract, section 4.3.
 *
 * One interface, two implementations: Tavily over plain `fetch` (no SDK) and a
 * canned stub for offline development. The Trend-Watcher seat imports only this
 * file, so swapping the provider is a config change (section 6.1) and nothing
 * more.
 *
 * No `server-only` here: the types are needed wherever the adapter is named.
 */

/** One search hit, normalised across providers. */
export interface SearchResult {
  title: string;
  url: string;
  content: string;
  /** Provider relevance score, where the provider supplies one. */
  score?: number;
}

export interface SearchOptions {
  maxResults?: number;
  /** Tavily's depth knob. `advanced` costs more and searches further. */
  searchDepth?: 'basic' | 'advanced';
  /** Caller cancellation, combined with the adapter's own timeout. */
  signal?: AbortSignal;
}

export interface SearchAdapter {
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

/** Default hit count. The Trend-Watcher cites a handful of sources, not a page. */
export const DEFAULT_MAX_RESULTS = 5;

/**
 * Search is a best-effort enrichment, never a hard dependency: a failed search
 * degrades the Trend-Watcher seat with a recorded warning (section 17.3) rather
 * than failing the run, so this is a local error type and not a run-level
 * `ErrorCode` from shared/constants.
 */
export class SearchError extends Error {
  readonly code = 'SEARCH_FAILED';

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}
