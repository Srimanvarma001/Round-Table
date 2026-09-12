import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Octokit as MockedOctokit,
} from '@octokit/rest';

import {
  computeSignals,
  fetchGithubSignals,
  median,
  readGithubCache,
  renderGithubSignalsForPrompt,
  writeGithubCache,
  type GithubRawPayload,
  type GithubRepoStats,
} from '@/lib/profile/github';
import { canonicalJson, computeSourceHash } from '@/lib/profile/hash';
import {
  chunkTasteNotes,
  readTasteNotes,
  readTasteNotesDetailed,
  renderNotesForPrompt,
  tasteNotesExist,
  writeTasteNotes,
} from '@/lib/profile/notes';
import {
  detectCvFormat,
  listCvUploads,
  readCv,
  readCvDetailed,
  readLatestCv,
} from '@/lib/profile/cv';
import { languageForFile, renderLocalScanForPrompt, scanLocalProjects } from '@/lib/profile/localScan';

vi.mock('@octokit/rest', () => ({ Octokit: vi.fn() }));
vi.mock('@octokit/graphql', () => {
  const query = vi.fn(async () => ({
    user: {
      contributionsCollection: {
        contributionCalendar: {
          totalContributions: 100,
          weeks: [
            { contributionDays: [{ date: '2026-09-01', contributionCount: 2 }] },
            { contributionDays: [{ date: '2026-09-02', contributionCount: 0 }] },
          ],
        },
      },
    },
  }));
  return { graphql: { defaults: vi.fn(() => query) } };
});
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText(): Promise<{ text: string }> {
      return { text: 'Mocked PDF text: staff engineer, TypeScript.' };
    }
  },
}));
vi.mock('mammoth', () => ({
  default: {
    extractRawText: async (): Promise<{ value: string }> => ({
      value: 'Mocked DOCX text: platform team lead.',
    }),
  },
}));

/**
 * Profile sources, sections 10.1 and 10.2. All offline: real temporary files
 * for notes/CV/local-scan, mocked Octokit and document parsers for the rest.
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = 1_789_084_800_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Taste notes
// ---------------------------------------------------------------------------

describe('taste notes', () => {
  it('reads, chunks, renders and writes through a temp path', async () => {
    const dir = tmpDir('notes-');
    const file = path.join(dir, 'taste.md');
    await writeTasteNotes('I like small tools.\nI abandon grand plans.\n', { filePath: file });

    expect(await tasteNotesExist({ filePath: file })).toBe(true);
    expect(await tasteNotesExist({ filePath: path.join(dir, 'missing.md') })).toBe(false);
    expect(await readTasteNotes({ filePath: file })).toContain('small tools');

    const detailed = await readTasteNotesDetailed({ filePath: file });
    expect(detailed.exists).toBe(true);
    expect(detailed.charCount).toBeGreaterThan(0);

    const missing = await readTasteNotesDetailed({ filePath: path.join(dir, 'missing.md') });
    expect(missing.exists).toBe(false);

    // Headings attach to chunks; content is split under the per-chunk cap.
    const chunks = chunkTasteNotes('# Likes\nI like small tools.\n# Dislikes\nI abandon grand plans.\n', {
      maxCharsPerChunk: 200,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.heading).toBe('Likes');
    expect(renderNotesForPrompt(chunks)).toContain('small tools');
  });
});

// ---------------------------------------------------------------------------
// CV
// ---------------------------------------------------------------------------

describe('cv', () => {
  it('detects formats by extension', () => {
    expect(detectCvFormat('cv.pdf')).toBe('pdf');
    expect(detectCvFormat('cv.DOCX')).toBe('docx');
    expect(detectCvFormat('cv.md')).toBe('markdown');
    expect(detectCvFormat('notes.txt')).toBe('text');
    expect(detectCvFormat('old.doc')).toBe('unsupported');
    expect(detectCvFormat('photo.png')).toBe('unknown');
  });

  it('reads markdown and text straight through from an override dir', async () => {
    const dir = tmpDir('cv-');
    await fs.promises.writeFile(path.join(dir, 'cv.md'), '# Jane\nStaff engineer, TypeScript.\n');
    const detailed = await readCvDetailed(path.join(dir, 'cv.md'));
    expect(detailed.ok).toBe(true);
    expect(detailed.format).toBe('markdown');
    expect(detailed.text).toContain('Staff engineer');
    expect(await readCv(path.join(dir, 'cv.md'))).toContain('Staff engineer');

    const latest = await readLatestCv({ dir });
    expect(latest.ok).toBe(true);

    const uploads = await listCvUploads({ dir });
    expect(uploads.map((f) => f.name)).toContain('cv.md');

    const empty = await readLatestCv({ dir: path.join(dir, 'empty') });
    expect(empty.ok).toBe(false);
  });

  it('extracts pdf and docx through the (mocked) document parsers', async () => {
    const dir = tmpDir('cv-bin-');
    await fs.promises.writeFile(path.join(dir, 'cv.pdf'), Buffer.from('%PDF-1.4 fake'));
    await fs.promises.writeFile(path.join(dir, 'cv.docx'), Buffer.from('PK fake'));

    expect(await readCv(path.join(dir, 'cv.pdf'))).toContain('Mocked PDF text');
    expect(await readCv(path.join(dir, 'cv.docx'))).toContain('Mocked DOCX text');
    const bad = await readCvDetailed(path.join(dir, 'photo.png'));
    expect(bad.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Local scan
// ---------------------------------------------------------------------------

describe('local scan', () => {
  it('detects stacks from manifests and never throws for missing paths', async () => {
    const root = tmpDir('scan-');
    const proj = path.join(root, 'plant-cli');
    await fs.promises.mkdir(path.join(proj, 'src'), { recursive: true });
    await fs.promises.writeFile(
      path.join(proj, 'package.json'),
      JSON.stringify({ name: 'plant-cli', dependencies: { next: '15.0.0' } }),
    );
    await fs.promises.writeFile(path.join(proj, 'src', 'index.ts'), 'console.log(1);\n'.repeat(50));
    await fs.promises.writeFile(path.join(proj, 'README.md'), '# Plant CLI\nA watering log.\n');

    const result = await scanLocalProjects([proj, path.join(root, 'missing')], { now: () => NOW });
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]!.manifests.map((m) => m.file)).toContain('package.json');
    expect(result.missingPaths).toHaveLength(1);
    expect(renderLocalScanForPrompt(result)).toContain('plant-cli');

    const empty = await scanLocalProjects([], { now: () => NOW });
    expect(empty.projects).toHaveLength(0);
  });

  it('maps file extensions to languages', () => {
    expect(languageForFile('index.ts')).toBe('TypeScript');
    expect(languageForFile('main.py')).toBe('Python');
    expect(languageForFile('photo.png')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GitHub signals (pure math)
// ---------------------------------------------------------------------------

function repo(overrides: Partial<GithubRepoStats> & { name: string }): GithubRepoStats {
  return {
    fullName: `me/${overrides.name}`,
    htmlUrl: `https://github.com/me/${overrides.name}`,
    description: null,
    isFork: false,
    isArchived: false,
    stars: 0,
    forks: 0,
    primaryLanguage: 'TypeScript',
    topics: [],
    sizeKb: 100,
    defaultBranch: 'main',
    createdAt: NOW - 400 * DAY,
    pushedAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY,
    ageDays: 400,
    daysSinceLastCommit: 10,
    commitCount: 30,
    commitStatsError: null,
    languageBytes: { TypeScript: 9000, JavaScript: 1000 },
    readmeFirstLine: 'A watering log.',
    ...overrides,
  };
}

function payload(): GithubRawPayload {
  return {
    username: 'me',
    fetchedAt: NOW,
    tokenPresent: true,
    repos: [
      repo({ name: 'shipped', stars: 42, topics: ['cli'] }),
      repo({
        name: 'abandoned',
        description: 'An old experiment.',
        commitCount: 12,
        daysSinceLastCommit: 400,
        pushedAt: NOW - 400 * DAY,
        updatedAt: NOW - 400 * DAY,
        stars: 3,
      }),
      repo({ name: 'forked', isFork: true, languageBytes: null }),
    ],
    pagination: { pagesFetched: 1, truncated: false, maxRepos: 300 },
    rateLimit: { limit: 5000, remaining: 4990 },
    contributionCalendar: {
      from: '2025-09-01',
      to: '2026-09-01',
      totalContributions: 300,
      dayCount: 365,
      activeDays: 180,
      density: 180 / 365,
      longestStreak: 20,
      currentStreak: 5,
    },
    detailSample: { languagesSampled: 2, readmesSampled: 2, limit: 60 },
  };
}

describe('github signal math', () => {
  it('computes shipped, abandoned, top languages, medians and stars', () => {
    const signals = computeSignals(payload());
    expect(signals.shipped.repoCount).toBe(1);
    expect(signals.shipped.repos).toContain('shipped');
    // The abandoned signal needs description + 5 commits + 12 months stale.
    expect(signals.abandoned.repoCount).toBe(1);
    expect(signals.abandoned.repos[0]!.name).toBe('abandoned');
    // Forks excluded from language bytes; top language first.
    expect(signals.topLanguages[0]).toMatchObject({ language: 'TypeScript' });
    expect(signals.topLanguages.length).toBeLessThanOrEqual(5);
    expect(signals.totalStars).toBe(45);
    expect(signals.topRepo?.name).toBe('shipped');
    expect(signals.medianCommitCount).toBe(30);
    expect(signals.contributionCalendar?.density).toBeCloseTo(180 / 365, 9);
    expect(renderGithubSignalsForPrompt(signals)).toContain('me');
  });

  it('median handles empty and even inputs', () => {
    expect(median([])).toBeNull();
    expect(median([3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('github cache', () => {
  it('round-trips, rejects other usernames and corrupt files', async () => {
    const dir = tmpDir('ghcache-');
    const cachePath = path.join(dir, 'github.json');
    const raw = payload();

    const written = await writeGithubCache(raw, { cachePath });
    expect(written.warning).toBeNull();

    const hit = await readGithubCache({ cachePath, username: 'me' });
    expect(hit?.payload.username).toBe('me');

    expect(await readGithubCache({ cachePath, username: 'someone-else' })).toBeNull();

    await fs.promises.writeFile(cachePath, 'not json{{{');
    expect(await readGithubCache({ cachePath })).toBeNull();
    expect(await readGithubCache({ cachePath: path.join(dir, 'absent.json') })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GitHub fetch (mocked network)
// ---------------------------------------------------------------------------

const OctokitMock = MockedOctokit as unknown as ReturnType<typeof vi.fn>;

function restRepo(name: string, pushedDaysAgo: number, stars: number, commits: number) {
  const pushed = new Date(NOW - pushedDaysAgo * DAY).toISOString();
  const created = new Date(NOW - 400 * DAY).toISOString();
  return {
    name,
    full_name: `me/${name}`,
    html_url: `https://github.com/me/${name}`,
    description: `${name} description`,
    fork: false,
    archived: false,
    stargazers_count: stars,
    forks_count: 1,
    language: 'TypeScript',
    topics: ['cli'],
    size: 120,
    default_branch: 'main',
    created_at: created,
    pushed_at: pushed,
    updated_at: pushed,
    __commits: commits,
    __pushed: pushed,
  };
}

function installOctokitMocks(repos: ReturnType<typeof restRepo>[]) {
  const listForUser = vi.fn(async () => ({ data: repos, headers: { link: '' } }));
  const listCommits = vi.fn(async (args: { repo: string }) => {
    const found = repos.find((r) => r.name === args.repo)!;
    return {
      data: [{ commit: { committer: { date: found.__pushed } } }],
      headers: { link: `<https://api.github.com/x?page=${found.__commits}>; rel="last"` },
    };
  });
  const listLanguages = vi.fn(async () => ({ data: { TypeScript: 9000 } }));
  const getReadme = vi.fn(async (args: { repo: string }) => ({
    data: {
      content: Buffer.from(`${args.repo} readme first line\nrest`).toString('base64'),
      encoding: 'base64',
    },
  }));
  const rateLimitGet = vi.fn(async () => ({
    data: { resources: { core: { limit: 5000, remaining: 4990 } } },
  }));
  // `new Octokit()` needs a constructable mock: arrow functions cannot be
  // constructed, so the implementation is a regular function.
  OctokitMock.mockImplementation(function (this: unknown) {
    return {
      rest: {
        rateLimit: { get: rateLimitGet },
        repos: { listForUser, listCommits, listLanguages, getReadme },
      },
    } as never;
  });
  // The contribution calendar is served by the graphql.defaults mock above.
  return { listForUser, listCommits };
}

describe('github fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches every section-10.2 signal from the mocked API', async () => {
    const dir = tmpDir('ghfetch-');
    installOctokitMocks([
      restRepo('shipped', 5, 42, 30),
      restRepo('abandoned', 400, 3, 12),
    ]);
    const result = await fetchGithubSignals({
      username: 'me',
      token: 'test-token',
      cachePath: path.join(dir, 'github.json'),
      force: true,
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.signals.shipped.repoCount).toBe(1);
    expect(result.signals.abandoned.repoCount).toBe(1);
    expect(result.signals.topLanguages[0]!.language).toBe('TypeScript');
    expect(result.signals.contributionCalendar?.activeDays).toBe(1);

    // Second call without force serves the cache without touching the API.
    const callsBefore = OctokitMock.mock.calls.length;
    const cached = await fetchGithubSignals({
      username: 'me',
      token: 'test-token',
      cachePath: path.join(dir, 'github.json'),
      now: () => NOW + 1000,
    });
    expect(cached.ok).toBe(true);
    expect(cached.signals.fromCache).toBe(true);
    expect(OctokitMock.mock.calls.length).toBe(callsBefore);
  });

  it('never throws: no username and API outage both come back as ok:false', async () => {
    expect((await fetchGithubSignals({ username: '', token: 'x' })).ok).toBe(false);

    OctokitMock.mockImplementation(function (this: unknown) {
      throw new Error('socket hang up');
    });
    const dir = tmpDir('ghfail-');
    const result = await fetchGithubSignals({
      username: 'me',
      token: 'test-token',
      cachePath: path.join(dir, 'github.json'),
      force: true,
      now: () => NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.signals.repoCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Source hash
// ---------------------------------------------------------------------------

describe('source hash', () => {
  it('is stable for identical inputs regardless of key order', () => {
    const a = computeSourceHash({ github: 'x', cv: null, local_scan: 'y', notes: null });
    const b = computeSourceHash({ notes: null, github: 'x', local_scan: 'y', cv: null });
    expect(a).toBe(b);
    expect(computeSourceHash({ github: 'z', cv: null, local_scan: 'y', notes: null })).not.toBe(a);
    expect(canonicalJson({ b: 1, a: [3, 2] })).toBe('{"a":[3,2],"b":1}');
  });
});
