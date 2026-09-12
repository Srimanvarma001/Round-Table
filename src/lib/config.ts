import 'server-only';

import { z } from 'zod';

/**
 * The single module in the codebase that reads `process.env`. Section 6.
 *
 * `server-only` guarantees an accidental client import is a build error rather
 * than a leaked API key. Keys are exposed through `providerKey()` and
 * `providerPresence()` so a caller can never accidentally serialise a secret
 * into a response — the presence helper is what the settings and health
 * routes report.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  GLM_API_KEY: z.string().default(''),
  GLM_BASE_URL: z.string().default('https://open.bigmodel.cn/api/paas/v4'),

  TAVILY_API_KEY: z.string().default(''),
  SEARCH_PROVIDER: z.enum(['tavily', 'stub']).default('tavily'),

  GITHUB_TOKEN: z.string().default(''),
  GITHUB_USERNAME: z.string().default(''),

  DATABASE_URL: z.string().default('file:./data/roundtable.db'),
  APP_USER_ID: z.string().default('local-user'),

  RUN_BUDGET_USD: z.coerce.number().positive().default(1.0),
  RUN_MAX_TOKENS: z.coerce.number().int().positive().default(250_000),
  RUN_MAX_CALLS: z.coerce.number().int().positive().default(60),

  LOG_LEVEL: z.string().default('info'),
  MOCK_LLM: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true' || v === '1'),
});

function load() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail loudly at boot on a malformed value, but never on a *missing*
    // optional variable: section 8.2 requires the app to boot without keys
    // and fail only on an actual generation attempt.
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

const env = load();

export const config = {
  NODE_ENV: env.NODE_ENV,
  isDev: env.NODE_ENV === 'development',
  isTest: env.NODE_ENV === 'test',

  DATABASE_URL: env.DATABASE_URL,
  APP_USER_ID: env.APP_USER_ID,

  SEARCH_PROVIDER: env.SEARCH_PROVIDER,
  GITHUB_USERNAME: env.GITHUB_USERNAME,

  RUN_BUDGET_USD: env.RUN_BUDGET_USD,
  RUN_MAX_TOKENS: env.RUN_MAX_TOKENS,
  RUN_MAX_CALLS: env.RUN_MAX_CALLS,

  LOG_LEVEL: env.LOG_LEVEL,
  MOCK_LLM: env.MOCK_LLM,
} as const;

export type ProviderName = 'glm';

export class MissingProviderKeyError extends Error {
  readonly code = 'MISSING_PROVIDER_KEY';
  constructor(readonly provider: ProviderName) {
    super(
      `No API key configured for provider "${provider}". ` +
        `Set ${provider.toUpperCase()}_API_KEY in .env.local.`,
    );
    this.name = 'MissingProviderKeyError';
  }
}

/** Base URL for a provider. Safe to expose. */
export function providerBaseUrl(provider: ProviderName): string {
  return env.GLM_BASE_URL;
}

/** Resolve a key at call time so the app boots with none configured. */
export function providerKey(provider: ProviderName): string {
  const key = env.GLM_API_KEY;
  if (!key) throw new MissingProviderKeyError(provider);
  return key;
}

export function tavilyKey(): string {
  if (!env.TAVILY_API_KEY) {
    throw new Error('No TAVILY_API_KEY configured. Set SEARCH_PROVIDER=stub for offline use.');
  }
  return env.TAVILY_API_KEY;
}

export function githubToken(): string {
  return env.GITHUB_TOKEN;
}

/**
 * Presence only, never values. This is what `/api/settings` and `/api/health`
 * report. Section 6.2.
 */
export function providerPresence() {
  return {
    glm: { configured: env.GLM_API_KEY.length > 0, baseUrl: env.GLM_BASE_URL },
    tavily: { configured: env.TAVILY_API_KEY.length > 0 },
    github: { configured: env.GITHUB_TOKEN.length > 0, username: env.GITHUB_USERNAME || null },
  };
}

/** Absolute path to the SQLite file, resolved from DATABASE_URL. */
export function databaseFilePath(): string {
  const url = env.DATABASE_URL;
  const raw = url.startsWith('file:') ? url.slice('file:'.length) : url;
  return raw;
}
