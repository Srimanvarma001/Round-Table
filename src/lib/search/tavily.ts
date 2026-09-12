import 'server-only';

import { tavilyKey } from '@/lib/config';

import {
  DEFAULT_MAX_RESULTS,
  SearchError,
  type SearchAdapter,
  type SearchOptions,
  type SearchResult,
} from './types';

/**
 * Tavily REST adapter, section 4.3: "Tavily REST API via `fetch`. No SDK
 * required."
 *
 * The key is read inside `search()` rather than the constructor. That keeps
 * `getSearchAdapter()` safe to call at boot with no `TAVILY_API_KEY`
 * configured (section 8.2's boot-without-keys rule) and makes the failure land
 * on the one call that actually needs a key.
 */

export const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';

/**
 * Search sits on the critical path of a single seat, so it gets a shorter
 * leash than a generation call: a slow search delays the whole step, and the
 * seat degrades gracefully when it gives up.
 */
export const DEFAULT_TAVILY_TIMEOUT_MS = 15_000;

/** The shape Tavily documents. Everything is optional: it is an external API. */
interface TavilyResponse {
  results?: Array<{
    title?: unknown;
    url?: unknown;
    content?: unknown;
    score?: unknown;
  }>;
}

export interface TavilySearchAdapterOptions {
  timeoutMs?: number;
}

export class TavilySearchAdapter implements SearchAdapter {
  private readonly timeoutMs: number;

  constructor(options: TavilySearchAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TAVILY_TIMEOUT_MS;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    let apiKey: string;
    try {
      apiKey = tavilyKey();
    } catch (err) {
      // config throws a plain Error; re-type it so the seat has one thing to
      // catch, and so the message survives into the recorded warning.
      throw new SearchError(
        err instanceof Error ? err.message : 'No TAVILY_API_KEY configured.',
        err,
      );
    }

    const timeout = AbortSignal.timeout(this.timeoutMs);
    // The caller's signal and our own timeout both have to be able to end the
    // request, so they are combined rather than one replacing the other.
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(TAVILY_SEARCH_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query: trimmed,
          max_results: opts.maxResults ?? DEFAULT_MAX_RESULTS,
          search_depth: opts.searchDepth ?? 'basic',
        }),
        signal,
      });
    } catch (err) {
      throw new SearchError(
        opts.signal?.aborted
          ? 'Tavily search aborted by the caller.'
          : `Tavily search failed: ${errorMessage(err)}`,
        err,
      );
    }

    if (!response.ok) {
      // Tavily puts a human-readable string in the body on 4xx; keep it, it is
      // the difference between "rate limited" and "bad key".
      const detail = await safeText(response);
      throw new SearchError(
        `Tavily search returned ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }

    let payload: TavilyResponse;
    try {
      payload = (await response.json()) as TavilyResponse;
    } catch (err) {
      throw new SearchError(`Tavily returned a non-JSON body: ${errorMessage(err)}`, err);
    }

    return toSearchResults(payload);
  }
}

/** Map the provider payload into the normalised shape; drop unusable rows. */
function toSearchResults(payload: TavilyResponse): SearchResult[] {
  const rows = Array.isArray(payload.results) ? payload.results : [];
  const results: SearchResult[] = [];

  for (const row of rows) {
    const url = typeof row?.url === 'string' ? row.url : '';
    if (!url) continue; // a hit with no URL cannot be cited, so it is not a hit

    results.push({
      title: typeof row.title === 'string' ? row.title : url,
      url,
      content: typeof row.content === 'string' ? row.content : '',
      ...(typeof row.score === 'number' ? { score: row.score } : {}),
    });
  }

  return results;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
