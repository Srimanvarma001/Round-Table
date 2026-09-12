import './env';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STUB_NOTICE,
  StubSearchAdapter,
  TavilySearchAdapter,
  clearSearchAdapterCache,
  getSearchAdapter,
  SearchError,
} from '@/lib/search/index';

vi.mock('@/lib/config', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/config')>();
  return { ...mod, tavilyKey: () => 'test-key' };
});

/**
 * Search adapters, section 4.3. The stub is deterministic and offline; Tavily
 * runs against a stubbed fetch. The Trend-Watcher only ever sees
 * `SearchResult[]`, so both are asserted through that shape.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  clearSearchAdapterCache();
});

describe('StubSearchAdapter', () => {
  it('returns deterministic, self-declared stub hits', async () => {
    const adapter = new StubSearchAdapter();
    const first = await adapter.search('plant watering sensors');
    const second = await adapter.search('plant watering sensors');
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    for (const hit of first) {
      expect(hit.title).toContain(STUB_NOTICE);
      expect(hit.url).toContain('stub.invalid');
    }
    expect(await adapter.search('   ')).toEqual([]);
    expect((await adapter.search('x', { maxResults: 2 })).length).toBeLessThanOrEqual(2);
  });
});

describe('TavilySearchAdapter', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('maps Tavily results into SearchResult', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [
          { title: 'Real post', url: 'https://example.com/a', content: 'Body text.', score: 0.9 },
          { title: null, url: null, content: null },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const hits = await new TavilySearchAdapter().search('watering sensors');
    expect(hits[0]).toMatchObject({ title: 'Real post', url: 'https://example.com/a' });
    expect(hits).toHaveLength(1); // the empty row is dropped, not returned half-built
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ api_key: 'test-key' });
  });

  it('wraps transport failures, HTTP errors and bad JSON in SearchError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('socket hang up');
    }));
    await expect(new TavilySearchAdapter().search('x')).rejects.toBeInstanceOf(SearchError);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
    await expect(new TavilySearchAdapter().search('x')).rejects.toThrow(/401/);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json{{{', { status: 200 })),
    );
    await expect(new TavilySearchAdapter().search('x')).rejects.toBeInstanceOf(SearchError);

    expect(await new TavilySearchAdapter().search('   ')).toEqual([]);
  });
});

describe('getSearchAdapter', () => {
  it('memoises one instance and serves the stub in this environment', () => {
    const first = getSearchAdapter();
    expect(getSearchAdapter()).toBe(first);
    expect(first).toBeInstanceOf(StubSearchAdapter);
  });
});
