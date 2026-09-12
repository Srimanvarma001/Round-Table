import 'server-only';

import { config, providerBaseUrl, providerKey, type ProviderName } from '@/lib/config';
import type { ProviderKey } from '@/shared/constants';

import { MockLLMAdapter } from './mock';
import { OpenAICompatibleAdapter } from './openai-compatible';
import type { LLMAdapter } from './types';

/**
 * `{provider, modelId}` -> adapter instance, section 8.2.
 *
 * The registry is the ONLY place that resolves a provider key, and it does so
 * at call time rather than import time. That is what lets the app boot with an
 * empty `.env.local`: importing this module never throws, and
 * `MissingProviderKeyError` surfaces from `getAdapter()` — that is, from an
 * actual generation attempt — instead. Section 8.2 states this requirement
 * explicitly, and section 6 makes it a product requirement (the settings page
 * must render with no keys configured).
 *
 * Adapters are memoised per provider because each one owns an HTTP client with
 * a configured base URL, timeout and retry policy. A failed construction is
 * never cached, so a key added to the environment later is picked up on the
 * next call without a restart.
 */

/** Providers a real adapter can serve. `'mock'` never reaches this module. */
export type AdapterProvider = ProviderName;

const adapterCache = new Map<ProviderName, LLMAdapter>();

let mockAdapter: MockLLMAdapter | null = null;

/**
 * The memoised mock, so `resolveAdapter` and an integration test's
 * `setScript()` call operate on the same instance.
 */
export function getMockAdapter(): MockLLMAdapter {
  if (!mockAdapter) mockAdapter = new MockLLMAdapter();
  return mockAdapter;
}

/**
 * Resolve the adapter for a provider. Throws `MissingProviderKeyError` when
 * the provider has no key configured — at call time, never at import time.
 */
export function getAdapter(provider: AdapterProvider): LLMAdapter {
  const cached = adapterCache.get(provider);
  if (cached) return cached;

  // Throws MissingProviderKeyError (from lib/config) when unset. Deliberately
  // not caught: the scheduler records it against the task as a non-retryable
  // failure with error code MISSING_PROVIDER_KEY.
  const apiKey = providerKey(provider);

  const adapter = new OpenAICompatibleAdapter({
    provider,
    apiKey,
    baseURL: providerBaseUrl(provider),
  });

  adapterCache.set(provider, adapter);
  return adapter;
}

/**
 * The entry point every step module uses. Returns the mock when
 * `MOCK_LLM=true` or the seat itself is configured as `mock`, so a run is
 * reproducible offline (section 6.1) without any step module knowing.
 */
export function resolveAdapter(provider: ProviderKey): LLMAdapter {
  if (config.MOCK_LLM || provider === 'mock') return getMockAdapter();
  return getAdapter(provider);
}

/**
 * Drop the memoised instances. Test-only: it exists so a suite can guarantee a
 * fresh mock (empty `calls`, no script) between cases, and so a suite that
 * installs a key at runtime is not served a stale construction failure.
 */
export function clearAdapterCache(): void {
  adapterCache.clear();
  mockAdapter = null;
}
