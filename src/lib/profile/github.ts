import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';

import { graphql } from '@octokit/graphql';
import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest';

import { config, githubToken } from '@/lib/config';
import { logger } from '@/lib/logger';

/**
 * GitHub ingestor, section 10.2.
 *
 * REST (`@octokit/rest`) for repositories, languages, topics and READMEs;
 * GraphQL (`@octokit/graphql`) for the contribution calendar. Every signal
 * section 10.2 names is computed here, deterministically, and the raw payload
 * is cached so a re-run costs nothing:
 *
 *  - top five languages by bytes across non-fork repos
 *  - the "shipped" count: repos with a commit in the last 90 days
 *  - the "abandoned" count: repos with a description, >= 5 commits and no
 *    commit in twelve months — the single most valuable input to the Mentor
 *    seat, so it is a first-class field (`abandoned.repos`), not a number
 *  - median repo age and median commit count
 *  - topics and README first lines
 *  - total stars and the highest-starred repo
 *  - contribution-calendar density over the last year
 *
 * Behaviour rules:
 *  - **Never throws.** Every failure is a warning on the result and an `ok:
 *    false` + `error`, which the pipeline records as an ingest run so a failed
 *    GitHub fetch is visible rather than silent (section 10.6).
 *  - Works without `GITHUB_TOKEN`, warning about the 60 requests/hour limit and
 *    shrinking its own request budget so it stays inside it.
 *  - Paginates, caps at 300 repositories (section 10.2), and caches the raw
 *    payload under `data/cache/github.json` with a timestamp.
 */

/** Hard cap from section 10.2. */
export const MAX_REPOS = 300;

/**
 * Unauthenticated budget. GitHub allows 60 requests/hour without a token and we
 * also need one call for the rate limit and one for the repo page, so the repo
 * cap and the per-repo detail sample are both small on purpose.
 */
export const MAX_REPOS_WITHOUT_TOKEN = 20;

/** Repos we spend extra requests on for languages and README first lines. */
export const DETAIL_SAMPLE_LIMIT = 60;
export const DETAIL_SAMPLE_LIMIT_WITHOUT_TOKEN = 8;

/** The "shipped" window, section 10.2. */
export const SHIPPED_WINDOW_DAYS = 90;

/** The "abandoned" window and commit floor, section 10.2. */
export const ABANDONED_STALE_DAYS = 365;
export const ABANDONED_MIN_COMMITS = 5;

/** How long a cache entry is considered fresh. `force` skips this check. */
export const DEFAULT_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Requests in flight. Matches the global cap in section 17.1. */
const REQUEST_CONCURRENCY = 6;

/** Top languages kept, section 10.2. */
const TOP_LANGUAGE_COUNT = 5;

/** Topics and README lines kept, to stop the prompt growing without bound. */
const MAX_TOPICS = 25;
const MAX_README_LINES = 25;

export const GITHUB_CACHE_RELATIVE_PATH = path.join('data', 'cache', 'github.json');

export interface GithubRepoStats {
  name: string;
  fullName: string;
  htmlUrl: string;
  description: string | null;
  isFork: boolean;
  isArchived: boolean;
  stars: number;
  forks: number;
  primaryLanguage: string | null;
  topics: string[];
  sizeKb: number;
  defaultBranch: string;
  createdAt: number;
  pushedAt: number;
  updatedAt: number;
  /** Whole days between `createdAt` and the fetch. */
  ageDays: number;
  /** Days since the newest commit, or null when commit stats are unavailable. */
  daysSinceLastCommit: number | null;
  /** Total commits on the default branch, or null when unavailable. */
  commitCount: number | null;
  /** Non-null when the per-repo commit request failed (empty repo, 403, ...). */
  commitStatsError: string | null;
  /** Bytes per language, only for the sampled repositories. */
  languageBytes: Record<string, number> | null;
  readmeFirstLine: string | null;
}

export interface GithubTopLanguage {
  language: string;
  bytes: number;
  /** Share of all sampled bytes, 0 to 1. */
  share: number;
  repoCount: number;
}

export interface GithubAbandonedRepo {
  name: string;
  htmlUrl: string;
  description: string | null;
  commitCount: number;
  daysSinceLastCommit: number | null;
  stars: number;
}

export interface GithubShippedRepos {
  windowDays: number;
  repoCount: number;
  repos: string[];
}

export interface GithubAbandonedSignal {
  minCommits: number;
  staleDays: number;
  repoCount: number;
  /**
   * The abandoned repositories themselves. Section 10.2 calls this "the most
   * valuable single input to the Mentor seat", so it is returned in full rather
   * than reduced to a count.
   */
  repos: GithubAbandonedRepo[];
}

export interface GithubContributionCalendar {
  from: string;
  to: string;
  totalContributions: number;
  dayCount: number;
  activeDays: number;
  /** activeDays / dayCount, 0 to 1. The "current cadence" signal. */
  density: number;
  longestStreak: number;
  currentStreak: number;
}

export interface GithubSignals {
  username: string;
  fetchedAt: number;
  fromCache: boolean;
  cacheAgeMs: number | null;
  tokenPresent: boolean;

  repoCount: number;
  nonForkRepoCount: number;
  reposTruncated: boolean;
  maxRepos: number;
  reposWithCommitStats: number;

  topLanguages: GithubTopLanguage[];

  shipped: GithubShippedRepos;
  abandoned: GithubAbandonedSignal;

  medianRepoAgeDays: number | null;
  medianCommitCount: number | null;

  topics: Array<{ topic: string; count: number }>;
  readmeFirstLines: Array<{ repo: string; line: string }>;

  totalStars: number;
  topRepo: { name: string; htmlUrl: string; stars: number; description: string | null } | null;

  contributionCalendar: GithubContributionCalendar | null;

  warnings: string[];
}

export interface GithubRawPayload {
  username: string;
  fetchedAt: number;
  tokenPresent: boolean;
  repos: GithubRepoStats[];
  pagination: { pagesFetched: number; truncated: boolean; maxRepos: number };
  rateLimit: { limit: number; remaining: number } | null;
  contributionCalendar: GithubContributionCalendar | null;
  detailSample: { languagesSampled: number; readmesSampled: number; limit: number };
}

export interface GithubFetchResult {
  /** False when nothing could be fetched at all (no token AND no username, 404, outage). */
  ok: boolean;
  /** Human-readable failure reason, safe to display. Null on success. */
  error: string | null;
  signals: GithubSignals;
  /** The raw payload, for hashing and for the cache. */
  raw: GithubRawPayload;
  warnings: string[];
}

export interface GithubFetchOptions {
  /** Defaults to `GITHUB_USERNAME`. */
  username?: string;
  /** Defaults to `GITHUB_TOKEN`; an empty string means "unauthenticated". */
  token?: string;
  /** Ignore a fresh cache and hit the API. The cache is still rewritten. */
  force?: boolean;
  /** Repository cap. Defaults to 300 with a token, 20 without. */
  maxRepos?: number;
  /** How long a cache entry stays usable. */
  maxAgeMs?: number;
  cachePath?: string;
  /** Reuse a stale cache when the network fails. Default true. */
  allowStaleCacheOnError?: boolean;
  detailSampleLimit?: number;
  signal?: AbortSignal;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Cache (section 10.2)
// ---------------------------------------------------------------------------

/** Absolute path of the GitHub cache file. */
export function githubCachePath(options: GithubFetchOptions = {}): string {
  if (options.cachePath) {
    return path.isAbsolute(options.cachePath)
      ? options.cachePath
      : path.join(process.cwd(), options.cachePath);
  }
  return path.join(process.cwd(), GITHUB_CACHE_RELATIVE_PATH);
}

interface GithubCacheFile {
  version: 1;
  username: string;
  cachedAt: number;
  payload: GithubRawPayload;
}

function isCacheFile(value: unknown): value is GithubCacheFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GithubCacheFile>;
  return (
    candidate.version === 1 &&
    typeof candidate.cachedAt === 'number' &&
    typeof candidate.username === 'string' &&
    !!candidate.payload &&
    Array.isArray(candidate.payload.repos)
  );
}

/**
 * Read the cache. Returns `null` when it is absent, unreadable, corrupt or
 * belongs to a different username. Never throws.
 */
export async function readGithubCache(
  options: GithubFetchOptions = {},
): Promise<{ payload: GithubRawPayload; cachedAt: number } | null> {
  const file = githubCachePath(options);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isCacheFile(parsed)) return null;
    // A cache for another account is worse than no cache: it would silently
    // describe the wrong person.
    if (options.username && parsed.username !== options.username) return null;
    return { payload: parsed.payload, cachedAt: parsed.cachedAt };
  } catch {
    return null;
  }
}

/** Write the cache. Returns the path, or a warning string when the write failed. */
export async function writeGithubCache(
  payload: GithubRawPayload,
  options: GithubFetchOptions = {},
): Promise<{ path: string; warning: string | null }> {
  const file = githubCachePath(options);
  const body: GithubCacheFile = {
    version: 1,
    username: payload.username,
    cachedAt: payload.fetchedAt,
    payload,
  };
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(body), 'utf8');
    return { path: file, warning: null };
  } catch (err) {
    logger.warn({ err, path: file }, 'profile.github: could not write cache');
    return {
      path: file,
      warning: `Could not cache the GitHub payload at ${file}: ${message(err)}. The next run will hit the API again.`,
    };
  }
}

/** Drop the cache. Used by the editor's "force refresh" action. */
export async function clearGithubCache(options: GithubFetchOptions = {}): Promise<boolean> {
  try {
    await fs.rm(githubCachePath(options), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch every signal in section 10.2, from the cache when it is fresh.
 *
 * This is the module's one entry point and it **never throws**: a missing token,
 * a missing username, a 404, a rate-limit rejection or an outage all come back
 * as `ok: false` with an `error` string and an empty-but-well-formed signal set.
 */
export async function fetchGithubSignals(options: GithubFetchOptions = {}): Promise<GithubFetchResult> {
  const now = options.now ?? (() => Date.now());
  // Section 6.1: all environment access goes through `config`.
  const username = (options.username ?? config.GITHUB_USERNAME ?? '').trim();
  const token = (options.token ?? safeGithubToken()).trim();
  const tokenPresent = token.length > 0;
  const warnings: string[] = [];

  const maxRepos = options.maxRepos ?? (tokenPresent ? MAX_REPOS : MAX_REPOS_WITHOUT_TOKEN);
  const detailSampleLimit =
    options.detailSampleLimit ?? (tokenPresent ? DETAIL_SAMPLE_LIMIT : DETAIL_SAMPLE_LIMIT_WITHOUT_TOKEN);

  const empty = (error: string | null): GithubFetchResult => ({
    ok: false,
    error,
    signals: emptySignals({ username, fetchedAt: now(), tokenPresent, maxRepos, warnings }),
    raw: {
      username,
      fetchedAt: now(),
      tokenPresent,
      repos: [],
      pagination: { pagesFetched: 0, truncated: false, maxRepos },
      rateLimit: null,
      contributionCalendar: null,
      detailSample: { languagesSampled: 0, readmesSampled: 0, limit: detailSampleLimit },
    },
    warnings,
  });

  if (!username) {
    warnings.push(
      'GITHUB_USERNAME is not configured. Set it in .env.local to ingest GitHub signals.',
    );
    return empty('GITHUB_USERNAME is not set, so no GitHub account could be analysed.');
  }

  if (!tokenPresent) {
    warnings.push(
      'No GITHUB_TOKEN configured. GitHub rate limits unauthenticated requests to 60 per hour, so the scan is reduced to ' +
        `${MAX_REPOS_WITHOUT_TOKEN} repositories and ${DETAIL_SAMPLE_LIMIT_WITHOUT_TOKEN} detail lookups. ` +
        'Set GITHUB_TOKEN for full coverage.',
    );
  }

  const file = githubCachePath(options);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS;

  if (!options.force) {
    const cached = await readGithubCache({ ...options, username });
    if (cached) {
      const age = now() - cached.cachedAt;
      if (age <= maxAgeMs) {
        const result = buildResult(cached.payload, {
          fromCache: true,
          cacheAgeMs: age,
          extraWarnings: warnings,
          tokenPresent,
          maxRepos,
        });
        return result;
      }
    }
  }

  let payload: GithubRawPayload;
  try {
    payload = await fetchRawPayload({
      username,
      token,
      tokenPresent,
      maxRepos,
      detailSampleLimit,
      signal: options.signal,
      now,
      warnings,
    });
  } catch (err) {
    logger.warn({ err, username }, 'profile.github: fetch failed');
    const reason = describeFetchError(err);

    // Falling back to a stale cache is strictly better than showing the user
    // nothing: the signals are labelled with their age.
    const stale = await readGithubCache({ ...options, username });
    if (stale && options.allowStaleCacheOnError !== false) {
      warnings.push(
        `GitHub fetch failed (${reason}); using the cached payload from ${new Date(stale.cachedAt).toISOString()}.`,
      );
      return buildResult(stale.payload, {
        fromCache: true,
        cacheAgeMs: now() - stale.cachedAt,
        extraWarnings: warnings,
        tokenPresent,
        maxRepos,
      });
    }

    // `empty()` shares the `warnings` array, so the reason is already attached.
    return empty(reason);
  }

  const writeResult = await writeGithubCache(payload, options);
  if (writeResult.warning) warnings.push(writeResult.warning);

  if (payload.pagination.truncated) {
    warnings.push(
      `More than ${maxRepos} repositories matched; signals cover the ${maxRepos} most recently pushed.`,
    );
  }

  const result = buildResult(payload, {
    fromCache: false,
    cacheAgeMs: null,
    extraWarnings: warnings,
    tokenPresent,
    maxRepos,
  });
  logger.info(
    { username, repos: payload.repos.length, file, fromCache: false },
    'profile.github: fetched signals',
  );
  return result;
}

/** `config.githubToken()` already returns `''` when unset; this only guards a throw. */
function safeGithubToken(): string {
  try {
    return githubToken();
  } catch {
    return '';
  }
}

interface RawFetchContext {
  username: string;
  token: string;
  tokenPresent: boolean;
  maxRepos: number;
  detailSampleLimit: number;
  signal?: AbortSignal;
  now: () => number;
  warnings: string[];
}

async function fetchRawPayload(ctx: RawFetchContext): Promise<GithubRawPayload> {
  const fetchedAt = ctx.now();
  const octokit = new Octokit(ctx.tokenPresent ? { auth: ctx.token } : {});

  // One cheap call up front tells us whether the plan even fits in the budget.
  let rateLimit: { limit: number; remaining: number } | null = null;
  try {
    const res = await octokit.rest.rateLimit.get();
    const core = res.data.resources?.core;
    if (core) {
      rateLimit = { limit: core.limit, remaining: core.remaining };
      if (core.remaining < 10) {
        ctx.warnings.push(
          `GitHub API budget is nearly exhausted: ${core.remaining} of ${core.limit} requests remain this hour.`,
        );
      }
    }
  } catch (err) {
    // The rate-limit endpoint is a convenience, not a requirement.
    logger.debug({ err }, 'profile.github: rate limit lookup failed');
  }

  const { repos: rawRepos, pagesFetched, truncated } = await listRepos(octokit, ctx);

  const nowMs = fetchedAt;
  const stats: GithubRepoStats[] = rawRepos.map((repo) => toRepoStats(repo, nowMs));

  // Commit stats for every repo: one request each returns both the total commit
  // count (from the Link header) and the newest commit date.
  await mapWithConcurrency(stats, REQUEST_CONCURRENCY, async (repo) => {
    if (ctx.signal?.aborted) return;
    try {
      const res = await octokit.rest.repos.listCommits({
        owner: ctx.username,
        repo: repo.name,
        sha: repo.defaultBranch,
        per_page: 1,
      });
      const latest = res.data[0]?.commit?.committer?.date ?? res.data[0]?.commit?.author?.date ?? null;
      const latestMs = latest ? Date.parse(latest) : Number.NaN;
      repo.commitCount = parseLastPage(res.headers.link) ?? res.data.length;
      repo.daysSinceLastCommit = Number.isFinite(latestMs) ? daysBetween(latestMs, nowMs) : null;
      repo.commitStatsError = null;
    } catch (err) {
      repo.commitCount = null;
      repo.daysSinceLastCommit = null;
      repo.commitStatsError = describeFetchError(err);
    }
  });

  // Languages and READMEs cost an extra request per repo, so they are sampled
  // from the most-starred repositories — those are the ones that characterise
  // what the user values publicly.
  const sample = stats
    .filter((repo) => !repo.isFork)
    .sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, ctx.detailSampleLimit));

  let languagesSampled = 0;
  let readmesSampled = 0;

  await mapWithConcurrency(sample, REQUEST_CONCURRENCY, async (repo) => {
    if (ctx.signal?.aborted) return;

    try {
      const res = await octokit.rest.repos.listLanguages({ owner: ctx.username, repo: repo.name });
      repo.languageBytes = res.data as Record<string, number>;
      languagesSampled += 1;
    } catch (err) {
      logger.debug({ err, repo: repo.name }, 'profile.github: language lookup failed');
    }

    try {
      const res = await octokit.rest.repos.getReadme({ owner: ctx.username, repo: repo.name });
      repo.readmeFirstLine = firstLineFromReadme(res.data.content, res.data.encoding);
      readmesSampled += 1;
    } catch {
      // A repo without a README is normal; no warning.
    }
  });

  if (sample.length < stats.filter((r) => !r.isFork).length) {
    ctx.warnings.push(
      `Languages and READMEs were sampled from ${sample.length} of ${stats.length} repositories to stay inside the API budget.`,
    );
  }

  const contributionCalendar = await fetchContributionCalendar(ctx);

  return {
    username: ctx.username,
    fetchedAt,
    tokenPresent: ctx.tokenPresent,
    repos: stats,
    pagination: { pagesFetched, truncated, maxRepos: ctx.maxRepos },
    rateLimit,
    contributionCalendar,
    detailSample: { languagesSampled, readmesSampled, limit: ctx.detailSampleLimit },
  };
}

type RepoListItem = RestEndpointMethodTypes['repos']['listForUser']['response']['data'][number];

/** Paginate the repo list, stopping exactly at the cap in section 10.2. */
async function listRepos(
  octokit: Octokit,
  ctx: RawFetchContext,
): Promise<{ repos: RepoListItem[]; pagesFetched: number; truncated: boolean }> {
  // Asking for exactly `maxRepos` on the first page means the "truncated" flag
  // below reflects whether GitHub actually had more, rather than whether we
  // happened to round up to a page boundary.
  const perPage = Math.max(1, Math.min(100, ctx.maxRepos));
  const repos: RepoListItem[] = [];
  let pagesFetched = 0;
  let truncated = false;

  for (let page = 1; repos.length < ctx.maxRepos; page += 1) {
    if (ctx.signal?.aborted) break;

    const res = await octokit.rest.repos.listForUser({
      username: ctx.username,
      per_page: perPage,
      page,
      sort: 'pushed',
      direction: 'desc',
      type: 'owner',
    });
    pagesFetched += 1;
    repos.push(...res.data);

    const hasNext = (res.headers.link ?? '').includes('rel="next"');
    if (repos.length >= ctx.maxRepos) {
      truncated = hasNext;
      repos.length = Math.min(repos.length, ctx.maxRepos);
      break;
    }
    if (res.data.length < perPage || !hasNext) break;
  }

  return { repos, pagesFetched, truncated };
}

function toRepoStats(repo: RepoListItem, nowMs: number): GithubRepoStats {
  const createdAt = Date.parse(repo.created_at ?? '');
  return {
    // Octokit's REST types mark several list fields optional; a repo row
    // without them is still a usable row, so every one falls back rather than
    // failing the whole fetch.
    name: repo.name ?? '',
    fullName: repo.full_name ?? repo.name ?? '',
    htmlUrl: repo.html_url ?? '',
    description: repo.description ?? null,
    isFork: repo.fork,
    isArchived: repo.archived ?? false,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    primaryLanguage: repo.language ?? null,
    topics: repo.topics ?? [],
    sizeKb: repo.size ?? 0,
    defaultBranch: repo.default_branch ?? 'main',
    createdAt: Number.isFinite(createdAt) ? createdAt : nowMs,
    pushedAt: parseDate(repo.pushed_at, nowMs),
    updatedAt: parseDate(repo.updated_at, nowMs),
    ageDays: daysBetween(Number.isFinite(createdAt) ? createdAt : nowMs, nowMs),
    daysSinceLastCommit: null,
    commitCount: null,
    commitStatsError: null,
    languageBytes: null,
    readmeFirstLine: null,
  };
}

function parseDate(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `Link: <...&page=7>; rel="last"` — the cheapest exact commit count GitHub offers. */
function parseLastPage(link: string | undefined): number | null {
  if (!link) return null;
  const match = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
  if (!match?.[1]) return null;
  const page = Number.parseInt(match[1], 10);
  return Number.isFinite(page) ? page : null;
}

function firstLineFromReadme(content: string | undefined, encoding: string | undefined): string | null {
  if (!content) return null;
  let text: string;
  try {
    text = encoding === 'base64' ? Buffer.from(content, 'base64').toString('utf8') : content;
  } catch {
    return null;
  }
  for (const line of text.slice(0, 4000).split('\n')) {
    const clean = line.replace(/^#+\s*/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
    if (clean) return clean.slice(0, 200);
  }
  return null;
}

/**
 * Contribution calendar over the last year, GraphQL only (section 10.2).
 * Requires a token; without one GitHub answers 401 and we return null.
 */
async function fetchContributionCalendar(
  ctx: RawFetchContext,
): Promise<GithubContributionCalendar | null> {
  if (!ctx.tokenPresent) {
    ctx.warnings.push(
      'The contribution calendar needs GITHUB_TOKEN; GitHub rejects unauthenticated GraphQL. Cadence signals are unavailable.',
    );
    return null;
  }

  const to = new Date(ctx.now());
  const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);

  const query = `query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays { date contributionCount }
          }
        }
      }
    }
  }`;

  try {
    const client = graphql.defaults({ headers: { authorization: `bearer ${ctx.token}` } });
    const data = await client<ContributionQueryResult>(query, {
      login: ctx.username,
      from: from.toISOString(),
      to: to.toISOString(),
    });

    const calendar = data.user?.contributionsCollection?.contributionCalendar;
    if (!calendar) return null;

    const days = calendar.weeks.flatMap((week) => week.contributionDays);
    const activeDays = days.filter((day) => day.contributionCount > 0).length;

    let longestStreak = 0;
    let running = 0;
    for (const day of days) {
      if (day.contributionCount > 0) {
        running += 1;
        longestStreak = Math.max(longestStreak, running);
      } else {
        running = 0;
      }
    }

    let currentStreak = 0;
    for (let i = days.length - 1; i >= 0; i -= 1) {
      const day = days[i];
      if (!day || day.contributionCount === 0) break;
      currentStreak += 1;
    }

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      totalContributions: calendar.totalContributions,
      dayCount: days.length,
      activeDays,
      density: days.length > 0 ? activeDays / days.length : 0,
      longestStreak,
      currentStreak,
    };
  } catch (err) {
    logger.warn({ err, username: ctx.username }, 'profile.github: contribution calendar failed');
    ctx.warnings.push(`Could not load the contribution calendar: ${describeFetchError(err)}`);
    return null;
  }
}

interface ContributionQueryResult {
  user: null | {
    contributionsCollection: {
      contributionCalendar: {
        totalContributions: number;
        weeks: Array<{ contributionDays: Array<{ date: string; contributionCount: number }> }>;
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Signals (section 10.2)
// ---------------------------------------------------------------------------

interface BuildResultContext {
  fromCache: boolean;
  cacheAgeMs: number | null;
  extraWarnings: string[];
  tokenPresent: boolean;
  maxRepos: number;
}

function buildResult(payload: GithubRawPayload, ctx: BuildResultContext): GithubFetchResult {
  const warnings = [...ctx.extraWarnings];
  for (const repo of payload.repos) {
    if (repo.commitStatsError && warnings.length < 40) {
      warnings.push(`Commit stats unavailable for ${repo.name}: ${repo.commitStatsError}`);
    }
  }

  const signals = computeSignals(payload, warnings);
  return {
    ok: true,
    error: null,
    signals: {
      ...signals,
      fromCache: ctx.fromCache,
      cacheAgeMs: ctx.cacheAgeMs,
      tokenPresent: ctx.tokenPresent,
      maxRepos: ctx.maxRepos,
    },
    raw: payload,
    warnings,
  };
}

function emptySignals(input: {
  username: string;
  fetchedAt: number;
  tokenPresent: boolean;
  maxRepos: number;
  warnings: string[];
}): GithubSignals {
  return {
    username: input.username,
    fetchedAt: input.fetchedAt,
    fromCache: false,
    cacheAgeMs: null,
    tokenPresent: input.tokenPresent,
    repoCount: 0,
    nonForkRepoCount: 0,
    reposTruncated: false,
    maxRepos: input.maxRepos,
    reposWithCommitStats: 0,
    topLanguages: [],
    shipped: { windowDays: SHIPPED_WINDOW_DAYS, repoCount: 0, repos: [] },
    abandoned: { minCommits: ABANDONED_MIN_COMMITS, staleDays: ABANDONED_STALE_DAYS, repoCount: 0, repos: [] },
    medianRepoAgeDays: null,
    medianCommitCount: null,
    topics: [],
    readmeFirstLines: [],
    totalStars: 0,
    topRepo: null,
    contributionCalendar: null,
    warnings: input.warnings,
  };
}

/**
 * Every derived signal from section 10.2, computed from the raw payload. Pure
 * and deterministic, which is what makes the cache worth having.
 */
export function computeSignals(payload: GithubRawPayload, warnings: string[] = []): GithubSignals {
  const repos = payload.repos;
  const nonFork = repos.filter((repo) => !repo.isFork);
  const withStats = repos.filter((repo) => repo.commitCount !== null);

  return {
    username: payload.username,
    fetchedAt: payload.fetchedAt,
    fromCache: false,
    cacheAgeMs: null,
    tokenPresent: payload.tokenPresent,

    repoCount: repos.length,
    nonForkRepoCount: nonFork.length,
    reposTruncated: payload.pagination.truncated,
    maxRepos: payload.pagination.maxRepos,
    reposWithCommitStats: withStats.length,

    topLanguages: topLanguages(nonFork),

    shipped: {
      windowDays: SHIPPED_WINDOW_DAYS,
      repoCount: nonFork.filter(
        (repo) => repo.daysSinceLastCommit !== null && repo.daysSinceLastCommit <= SHIPPED_WINDOW_DAYS,
      ).length,
      repos: nonFork
        .filter((repo) => repo.daysSinceLastCommit !== null && repo.daysSinceLastCommit <= SHIPPED_WINDOW_DAYS)
        .map((repo) => repo.name)
        .sort((a, b) => a.localeCompare(b)),
    },

    abandoned: abandonedSignal(nonFork),

    medianRepoAgeDays: median(nonFork.map((repo) => repo.ageDays)),
    medianCommitCount: median(withStats.map((repo) => repo.commitCount ?? 0)),

    topics: topTopics(repos),
    readmeFirstLines: readmeLines(repos),

    totalStars: repos.reduce((sum, repo) => sum + repo.stars, 0),
    topRepo: highestStarred(repos),

    contributionCalendar: payload.contributionCalendar,
    warnings,
  };
}

function topLanguages(nonFork: readonly GithubRepoStats[]): GithubTopLanguage[] {
  const bytesByLanguage = new Map<string, number>();
  const reposByLanguage = new Map<string, number>();

  for (const repo of nonFork) {
    if (!repo.languageBytes) continue;
    for (const [language, bytes] of Object.entries(repo.languageBytes)) {
      if (!Number.isFinite(bytes) || bytes <= 0) continue;
      bytesByLanguage.set(language, (bytesByLanguage.get(language) ?? 0) + bytes);
      reposByLanguage.set(language, (reposByLanguage.get(language) ?? 0) + 1);
    }
  }

  const total = [...bytesByLanguage.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (total === 0) return [];

  return [...bytesByLanguage.entries()]
    .map(([language, bytes]) => ({
      language,
      bytes,
      share: bytes / total,
      repoCount: reposByLanguage.get(language) ?? 0,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.language.localeCompare(b.language))
    .slice(0, TOP_LANGUAGE_COUNT);
}

/**
 * The abandoned signal (section 10.2): a description, at least five commits and
 * no commit in twelve months.
 */
function abandonedSignal(nonFork: readonly GithubRepoStats[]): GithubAbandonedSignal {
  const repos = nonFork
    .filter(
      (repo) =>
        !!repo.description?.trim() &&
        repo.commitCount !== null &&
        repo.commitCount >= ABANDONED_MIN_COMMITS &&
        repo.daysSinceLastCommit !== null &&
        repo.daysSinceLastCommit >= ABANDONED_STALE_DAYS,
    )
    .map((repo) => ({
      name: repo.name,
      htmlUrl: repo.htmlUrl,
      description: repo.description,
      commitCount: repo.commitCount ?? 0,
      daysSinceLastCommit: repo.daysSinceLastCommit,
      stars: repo.stars,
    }))
    .sort((a, b) => (b.daysSinceLastCommit ?? 0) - (a.daysSinceLastCommit ?? 0) || a.name.localeCompare(b.name));

  return {
    minCommits: ABANDONED_MIN_COMMITS,
    staleDays: ABANDONED_STALE_DAYS,
    repoCount: repos.length,
    repos,
  };
}

function topTopics(repos: readonly GithubRepoStats[]): Array<{ topic: string; count: number }> {
  const counts = new Map<string, number>();
  for (const repo of repos) {
    for (const topic of repo.topics) {
      const key = topic.trim().toLowerCase();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
    .slice(0, MAX_TOPICS);
}

function readmeLines(repos: readonly GithubRepoStats[]): Array<{ repo: string; line: string }> {
  return repos
    .filter((repo) => !!repo.readmeFirstLine)
    .map((repo) => ({ repo: repo.name, line: repo.readmeFirstLine ?? '' }))
    .sort((a, b) => a.repo.localeCompare(b.repo))
    .slice(0, MAX_README_LINES);
}

function highestStarred(
  repos: readonly GithubRepoStats[],
): GithubSignals['topRepo'] {
  let best: GithubRepoStats | null = null;
  for (const repo of repos) {
    if (repo.isFork) continue;
    if (!best || repo.stars > best.stars || (repo.stars === best.stars && repo.name < best.name)) best = repo;
  }
  return best
    ? { name: best.name, htmlUrl: best.htmlUrl, stars: best.stars, description: best.description }
    : null;
}

/** Median of a list, or null when empty. Exported because the merge rule needs it too. */
export function median(values: readonly number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 1) return clean[mid] ?? null;
  const low = clean[mid - 1];
  const high = clean[mid];
  if (low === undefined || high === undefined) return null;
  return (low + high) / 2;
}

// ---------------------------------------------------------------------------
// Prompt rendering (input to the section 10.3 extraction call)
// ---------------------------------------------------------------------------

/**
 * Render the signals as compact prompt input. Deterministic — the same signals
 * always produce byte-identical text, which is what makes `source_hash`
 * meaningful.
 */
export function renderGithubSignalsForPrompt(signals: GithubSignals): string {
  if (signals.repoCount === 0) {
    return `No GitHub repositories were available for ${signals.username || '(unknown user)'}.`;
  }

  const lines: string[] = [
    `GitHub account: ${signals.username}`,
    `Repositories analysed: ${signals.repoCount} (${signals.nonForkRepoCount} non-fork)`,
  ];

  if (signals.topLanguages.length > 0) {
    lines.push(
      `Top languages by bytes: ${signals.topLanguages
        .map((entry) => `${entry.language} ${(entry.share * 100).toFixed(1)}%`)
        .join(', ')}`,
    );
  }

  lines.push(
    `Repositories with a commit in the last ${signals.shipped.windowDays} days: ${signals.shipped.repoCount}`,
  );
  if (signals.shipped.repos.length > 0) {
    lines.push(`Recently active: ${signals.shipped.repos.slice(0, 15).join(', ')}`);
  }

  lines.push(
    `Dormant repositories (description, >= ${signals.abandoned.minCommits} commits, no commit in ${signals.abandoned.staleDays} days): ${signals.abandoned.repoCount}`,
  );
  for (const repo of signals.abandoned.repos.slice(0, 12)) {
    const idle = repo.daysSinceLastCommit === null ? 'unknown idle time' : `${repo.daysSinceLastCommit} days idle`;
    lines.push(
      `  - ${repo.name}: "${(repo.description ?? '').slice(0, 140)}" (${repo.commitCount} commits, ${idle}, ${repo.stars} stars)`,
    );
  }

  if (signals.medianRepoAgeDays !== null) {
    lines.push(`Median repository age: ${Math.round(signals.medianRepoAgeDays)} days`);
  }
  if (signals.medianCommitCount !== null) {
    lines.push(`Median commit count: ${Math.round(signals.medianCommitCount)}`);
  }

  if (signals.topics.length > 0) {
    lines.push(`Topics: ${signals.topics.slice(0, 20).map((t) => `${t.topic} (${t.count})`).join(', ')}`);
  }

  if (signals.readmeFirstLines.length > 0) {
    lines.push('README first lines:');
    for (const entry of signals.readmeFirstLines.slice(0, 15)) {
      lines.push(`  - ${entry.repo}: ${entry.line}`);
    }
  }

  lines.push(`Total stars: ${signals.totalStars}`);
  if (signals.topRepo) {
    lines.push(
      `Highest-starred repository: ${signals.topRepo.name} (${signals.topRepo.stars} stars)${
        signals.topRepo.description ? ` - ${signals.topRepo.description.slice(0, 140)}` : ''
      }`,
    );
  }

  const calendar = signals.contributionCalendar;
  if (calendar) {
    lines.push(
      `Contribution calendar ${calendar.from} to ${calendar.to}: ${calendar.totalContributions} contributions, ` +
        `${calendar.activeDays} active days of ${calendar.dayCount} (${(calendar.density * 100).toFixed(1)}% density), ` +
        `longest streak ${calendar.longestStreak} days, current streak ${calendar.currentStreak} days`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Whole days between two epoch-millisecond instants, never negative. */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / (24 * 60 * 60 * 1000)));
}

/**
 * Run `worker` over `items` with a bounded number in flight. Rejections are the
 * worker's problem: each one is expected to handle its own failure.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const size = Math.max(1, Math.min(limit, queue.length));
  const runners: Array<Promise<void>> = [];

  for (let i = 0; i < size; i += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const item = queue.shift();
          if (item === undefined) return;
          try {
            await worker(item);
          } catch (err) {
            // Defensive: a worker that throws must not poison the pool.
            logger.debug({ err }, 'profile.github: request worker failed');
          }
        }
      })(),
    );
  }

  await Promise.all(runners);
}

/** A short, human-readable reason. Never includes the token. */
function describeFetchError(err: unknown): string {
  if (err && typeof err === 'object') {
    const candidate = err as { status?: number; message?: string };
    if (typeof candidate.status === 'number') {
      if (candidate.status === 404) return 'GitHub user not found (404). Check GITHUB_USERNAME.';
      if (candidate.status === 401) return 'GitHub rejected the token (401). Check GITHUB_TOKEN.';
      if (candidate.status === 403) {
        return 'GitHub refused the request (403): rate limit or token scope. Check GITHUB_TOKEN and try again later.';
      }
      return `GitHub request failed with status ${candidate.status}.`;
    }
    if (candidate.message) return candidate.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
