import 'server-only';

import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '@/lib/logger';

/**
 * Local project folder scan, section 10.1.
 *
 * "Read manifests (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`) to
 * detect stacks. LLM pass only to summarise intent."
 *
 * That division is the whole design of this module: everything here is
 * **deterministic**. We read manifests, count file extensions and look for
 * conventional markers, and we produce the same result for the same folder
 * every time. No model is consulted — the only LLM call in the local-project
 * path lives in `extract.ts`, and it only ever sees the summary this module
 * produced.
 *
 * Missing folders are expected (the user moved a project) and produce a warning,
 * never a throw.
 */

/** Directories that are never worth walking, and would dominate the file count. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.idea',
  '.vscode',
  'obj',
  'Pods',
  'DerivedData',
]);

/** The four manifests section 10.1 names, in the order they are reported. */
const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'] as const;
export type ManifestFileName = (typeof MANIFEST_FILES)[number];

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_DEPENDENCIES_IN_SUMMARY = 40;
const MAX_SCRIPTS_IN_SUMMARY = 15;
const MAX_LANGUAGES_IN_SUMMARY = 8;

/** U+FEFF. Written as a code point so this source file stays plain ASCII. */
const BOM_CODE_POINT = 0xfeff;

export interface ManifestSummary {
  /** File name, for example `package.json`. */
  file: ManifestFileName;
  /** Project name declared by the manifest, when it has one. */
  name: string | null;
  /** Stacks the manifest implies, for example `Next.js`. */
  stacks: string[];
  /** Declared dependencies, sorted and capped. */
  dependencies: string[];
  /** Run scripts (npm) or task aliases, capped. */
  scripts: Record<string, string>;
  /** Non-null when the manifest exists but could not be parsed. */
  parseError: string | null;
}

export interface ScannedProject {
  path: string;
  name: string;
  manifests: ManifestSummary[];
  stacks: string[];
  /** Conventional markers: `docker`, `ci`, `tests`, `monorepo`, ... */
  markers: string[];
  readmeFirstLine: string | null;
  /** File counts by detected language, descending. */
  languages: Array<{ language: string; files: number }>;
  fileCount: number;
  lastModifiedAt: number | null;
  warnings: string[];
}

export interface LocalScanResult {
  projects: ScannedProject[];
  /** Union of every project's stacks, sorted. */
  stacks: string[];
  /** Paths that did not exist or were not directories. */
  missingPaths: string[];
  warnings: string[];
  scannedAt: number;
}

export interface LocalScanOptions {
  /** Directory depth walked when counting languages. Default 3. */
  maxDepth?: number;
  /** Hard cap on files inspected per project. Default 400. */
  maxFilesPerProject?: number;
  readmeMaxChars?: number;
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Scan a list of folders. Never throws: a folder that is missing, unreadable or
 * not a directory is reported through `missingPaths` and `warnings`.
 */
export async function scanLocalProjects(
  paths: readonly string[],
  options: LocalScanOptions = {},
): Promise<LocalScanResult> {
  const now = options.now ?? (() => Date.now());
  const projects: ScannedProject[] = [];
  const missingPaths: string[] = [];
  const warnings: string[] = [];

  const cleaned = paths.map((p) => p.trim()).filter((p) => p.length > 0);
  if (cleaned.length === 0) {
    return { projects, stacks: [], missingPaths, warnings, scannedAt: now() };
  }

  for (const requested of cleaned) {
    if (options.signal?.aborted) {
      warnings.push('Local scan was cancelled before it finished; results are partial.');
      break;
    }

    // The reason a folder was skipped is collected into this array, which keeps
    // `scanProjectFolder`'s return type a plain `ScannedProject | null`.
    const reason: string[] = [];
    let project: ScannedProject | null = null;
    try {
      project = await scanProjectFolder(requested, options, reason);
    } catch (err) {
      // Defensive: the folder scan handles its own failures, but a surprise here
      // must not abort the whole pipeline (section 17.5).
      logger.warn({ err, path: requested }, 'profile.localScan: folder scan failed');
      reason.push(`Could not scan ${requested}: ${message(err)}`);
    }

    if (project) {
      projects.push(project);
      for (const warning of project.warnings) warnings.push(warning);
    } else {
      missingPaths.push(requested);
      for (const warning of reason) warnings.push(warning);
    }
  }

  projects.sort((a, b) => a.path.localeCompare(b.path));

  return {
    projects,
    stacks: unionStacks(projects),
    missingPaths,
    warnings,
    scannedAt: now(),
  };
}

/** Sorted, deduplicated union of the stacks found across projects. */
function unionStacks(projects: readonly ScannedProject[]): string[] {
  const set = new Set<string>();
  for (const project of projects) for (const stack of project.stacks) set.add(stack);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Scan one folder.
 *
 * Returns `null` when the path is missing, unreadable or not a directory; the
 * human-readable reason is appended to `reason` so the caller can surface it.
 */
export async function scanProjectFolder(
  folder: string,
  options: LocalScanOptions = {},
  reason: string[] = [],
): Promise<ScannedProject | null> {
  const abs = path.resolve(folder);
  const warnings: string[] = [];

  let stat: Stats;
  try {
    stat = await fs.stat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    reason.push(
      code === 'ENOENT'
        ? `Local project folder not found: ${abs}`
        : `Local project folder is unreadable: ${abs} (${message(err)})`,
    );
    return null;
  }

  if (!stat.isDirectory()) {
    reason.push(`Local project path is not a directory: ${abs}`);
    return null;
  }

  const manifests: ManifestSummary[] = [];
  for (const file of MANIFEST_FILES) {
    const summary = await readManifest(abs, file);
    if (!summary) continue;
    manifests.push(summary);
    if (summary.parseError) warnings.push(`${abs}${path.sep}${file}: ${summary.parseError}`);
  }

  const markers = await detectMarkers(abs);
  const { languages, fileCount } = await countFiles(abs, options);

  const stacks = new Set<string>();
  for (const manifest of manifests) for (const stack of manifest.stacks) stacks.add(stack);
  for (const entry of languages) {
    if (entry.files >= 2 && LANGUAGE_STACKS.has(entry.language)) stacks.add(entry.language);
  }
  if (markers.includes('tests')) stacks.add('Tests');
  if (markers.includes('docker')) stacks.add('Docker');
  if (markers.includes('ci')) stacks.add('CI');

  const named = manifests.find((m) => m.name);

  return {
    path: abs,
    name: named?.name ?? path.basename(abs),
    manifests,
    stacks: [...stacks].sort((a, b) => a.localeCompare(b)),
    markers,
    readmeFirstLine: await readReadmeFirstLine(abs, options.readmeMaxChars),
    languages: languages.slice(0, MAX_LANGUAGES_IN_SUMMARY),
    fileCount,
    lastModifiedAt: Math.round(stat.mtimeMs),
    warnings,
  };
}

/** Languages worth naming as a "stack" on their own; markup and config are not. */
const LANGUAGE_STACKS = new Set([
  'TypeScript',
  'JavaScript',
  'Python',
  'Go',
  'Rust',
  'Java',
  'Kotlin',
  'Swift',
  'Ruby',
  'PHP',
  'C#',
  'C',
  'C++',
  'Elixir',
  'Dart',
  'Shell',
  'Lua',
  'SQL',
]);

async function readManifest(dir: string, file: ManifestFileName): Promise<ManifestSummary | null> {
  const full = path.join(dir, file);

  let text: string;
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    text = await fs.readFile(full, 'utf8');
  } catch {
    return null; // Absent manifest: not a warning, just no evidence.
  }

  try {
    switch (file) {
      case 'package.json':
        return parsePackageJson(text, file);
      case 'pyproject.toml':
        return parsePyproject(text, file);
      case 'go.mod':
        return parseGoMod(text, file);
      case 'Cargo.toml':
        return parseCargoToml(text, file);
      default:
        return null;
    }
  } catch (err) {
    return {
      file,
      name: null,
      stacks: [],
      dependencies: [],
      scripts: {},
      parseError: `could not parse (${message(err)})`,
    };
  }
}

function parsePackageJson(text: string, file: ManifestFileName): ManifestSummary {
  const pkg = JSON.parse(stripBom(text)) as {
    name?: unknown;
    dependencies?: unknown;
    devDependencies?: unknown;
    scripts?: unknown;
    type?: unknown;
  };

  const deps = new Set<string>();
  for (const key of ['dependencies', 'devDependencies'] as const) {
    const block = pkg[key];
    if (block && typeof block === 'object') {
      for (const name of Object.keys(block as Record<string, unknown>)) deps.add(name);
    }
  }

  const stacks = new Set<string>(['Node.js']);
  for (const dep of deps) for (const stack of STACK_BY_DEPENDENCY[dep.toLowerCase()] ?? []) stacks.add(stack);
  if (pkg.type === 'module') stacks.add('ESM');

  const scripts: Record<string, string> = {};
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const [name, value] of Object.entries(pkg.scripts as Record<string, unknown>).slice(
      0,
      MAX_SCRIPTS_IN_SUMMARY,
    )) {
      if (typeof value === 'string') scripts[name] = value.slice(0, 200);
    }
  }

  return {
    file,
    name: typeof pkg.name === 'string' ? pkg.name : null,
    stacks: sortStrings(stacks),
    dependencies: sortStrings(deps).slice(0, MAX_DEPENDENCIES_IN_SUMMARY),
    scripts,
    parseError: null,
  };
}

/**
 * `pyproject.toml` is TOML, and we are not adding a TOML parser dependency for
 * the three sections we care about. This is a deliberately shallow reader: it
 * picks up `[project] name`, the `dependencies` array, poetry/pdm dependency
 * tables and a few tool markers. Anything more elaborate is left to the LLM
 * summarisation pass in `extract.ts`.
 */
function parsePyproject(text: string, file: ManifestFileName): ManifestSummary {
  const body = stripBom(text);
  const deps = new Set<string>();
  const stacks = new Set<string>(['Python']);

  const nameMatch = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(body);
  const arrayDeps = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(body);
  if (arrayDeps?.[1]) {
    for (const raw of arrayDeps[1].split(',')) {
      const name = cleanDependencyName(raw);
      if (name) deps.add(name);
    }
  }

  // [tool.poetry.dependencies] and similar tables.
  const tableMatch = /\[tool\.[A-Za-z0-9_-]+\.(?:dev-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g;
  for (const table of body.matchAll(tableMatch)) {
    for (const line of (table[1] ?? '').split('\n')) {
      const depMatch = /^\s*([A-Za-z0-9._-]+)\s*=/.exec(line);
      const name = depMatch?.[1];
      if (name && name.toLowerCase() !== 'python') deps.add(name.toLowerCase());
    }
  }

  for (const dep of deps) for (const stack of STACK_BY_DEPENDENCY[dep] ?? []) stacks.add(stack);
  if (/\[tool\.poetry\]/.test(body)) stacks.add('Poetry');
  if (/\[tool\.uv\]/.test(body)) stacks.add('uv');
  if (/\[tool\.ruff\]/.test(body)) stacks.add('Ruff');
  if (/\[tool\.pytest/.test(body)) stacks.add('pytest');
  if (/hatchling|setuptools|poetry-core|flit/.test(body)) stacks.add('Packaging');

  return {
    file,
    name: nameMatch?.[1] ?? null,
    stacks: sortStrings(stacks),
    dependencies: sortStrings(deps).slice(0, MAX_DEPENDENCIES_IN_SUMMARY),
    scripts: {},
    parseError: null,
  };
}

/** `go.mod` is line-oriented enough to read without a parser. */
function parseGoMod(text: string, file: ManifestFileName): ManifestSummary {
  const body = stripBom(text);
  const deps = new Set<string>();
  const stacks = new Set<string>(['Go']);

  const moduleMatch = /^module\s+(\S+)/m.exec(body);
  const goVersion = /^go\s+(\d+\.\d+)/m.exec(body);
  if (goVersion?.[1]) stacks.add(`Go ${goVersion[1]}`);

  const lines: string[] = [];
  const requireBlock = /require\s*\(([\s\S]*?)\)/.exec(body);
  if (requireBlock?.[1]) lines.push(...requireBlock[1].split('\n'));
  for (const m of body.matchAll(/^require\s+(?!\()(.+)$/gm)) {
    lines.push(m[1]!.trim());
  }

  for (const line of lines) {
    const depMatch = /^\s*([A-Za-z0-9.\-/]+\.[A-Za-z]{2,}\/\S+)\s+v/.exec(line);
    if (depMatch?.[1]) deps.add(depMatch[1]);
  }

  for (const dep of deps) for (const stack of STACK_BY_DEPENDENCY[dep] ?? []) stacks.add(stack);

  const modulePath = moduleMatch?.[1] ?? null;
  return {
    file,
    name: modulePath ? (modulePath.split('/').pop() ?? modulePath) : null,
    stacks: sortStrings(stacks),
    dependencies: sortStrings(deps).slice(0, MAX_DEPENDENCIES_IN_SUMMARY),
    scripts: {},
    parseError: modulePath ? null : 'no module directive found',
  };
}

/** `Cargo.toml`, again read shallowly: `[package] name` and dependency tables. */
function parseCargoToml(text: string, file: ManifestFileName): ManifestSummary {
  const body = stripBom(text);
  const deps = new Set<string>();
  const stacks = new Set<string>(['Rust']);

  const nameMatch = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(body);
  const editionMatch = /^\s*edition\s*=\s*["']([^"']+)["']/m.exec(body);
  if (editionMatch?.[1]) stacks.add(`Rust ${editionMatch[1]}`);

  const tableMatch = /\[(?:dev-|build-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g;
  for (const table of body.matchAll(tableMatch)) {
    for (const line of (table[1] ?? '').split('\n')) {
      const depMatch = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
      const name = depMatch?.[1];
      if (name) deps.add(name);
    }
  }

  for (const dep of deps) for (const stack of STACK_BY_DEPENDENCY[dep] ?? []) stacks.add(stack);

  return {
    file,
    name: nameMatch?.[1] ?? null,
    stacks: sortStrings(stacks),
    dependencies: sortStrings(deps).slice(0, MAX_DEPENDENCIES_IN_SUMMARY),
    scripts: {},
    parseError: null,
  };
}

function cleanDependencyName(raw: string): string | null {
  const stripped = raw.trim().replace(/^["']|["']$/g, '').split(/[<>=!~;[\s\]]/)[0];
  if (!stripped) return null;
  const name = stripped.trim().toLowerCase();
  return name.length > 0 && name.length < 80 ? name : null;
}

function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === BOM_CODE_POINT ? text.slice(1) : text;
}

/**
 * Dependency name to stack. Keys are lowercase (npm and Python) and exact for
 * Go module paths and Rust crates. Deliberately small and curated: it exists to
 * make the deterministic pass useful, not to be exhaustive.
 */
const STACK_BY_DEPENDENCY: Record<string, string[]> = {
  // JavaScript / TypeScript
  next: ['Next.js'],
  react: ['React'],
  'react-dom': ['React'],
  'react-native': ['React Native'],
  vue: ['Vue'],
  nuxt: ['Nuxt'],
  svelte: ['Svelte'],
  '@angular/core': ['Angular'],
  astro: ['Astro'],
  remix: ['Remix'],
  express: ['Express'],
  fastify: ['Fastify'],
  koa: ['Koa'],
  nestjs: ['NestJS'],
  '@nestjs/core': ['NestJS'],
  hono: ['Hono'],
  typescript: ['TypeScript'],
  vite: ['Vite'],
  webpack: ['Webpack'],
  esbuild: ['esbuild'],
  turbo: ['Turborepo'],
  tailwindcss: ['Tailwind CSS'],
  sass: ['Sass'],
  'styled-components': ['CSS-in-JS'],
  '@emotion/react': ['CSS-in-JS'],
  'framer-motion': ['Framer Motion'],
  three: ['Three.js'],
  d3: ['D3'],
  'chart.js': ['Chart.js'],
  recharts: ['Recharts'],
  electron: ['Electron'],
  tauri: ['Tauri'],
  prisma: ['Prisma'],
  '@prisma/client': ['Prisma'],
  'drizzle-orm': ['Drizzle ORM'],
  typeorm: ['TypeORM'],
  sequelize: ['Sequelize'],
  mongoose: ['MongoDB'],
  pg: ['PostgreSQL'],
  postgres: ['PostgreSQL'],
  mysql2: ['MySQL'],
  redis: ['Redis'],
  ioredis: ['Redis'],
  zod: ['Zod'],
  vitest: ['Vitest'],
  jest: ['Jest'],
  mocha: ['Mocha'],
  '@playwright/test': ['Playwright'],
  cypress: ['Cypress'],
  eslint: ['ESLint'],
  prettier: ['Prettier'],
  openai: ['OpenAI API'],
  '@anthropic-ai/sdk': ['Anthropic API'],
  langchain: ['LangChain'],
  ai: ['Vercel AI SDK'],
  socket: ['WebSockets'],
  'socket.io': ['WebSockets'],
  ws: ['WebSockets'],
  'discord.js': ['Discord bots'],
  telegraf: ['Telegram bots'],
  '@octokit/rest': ['GitHub API'],

  // Python
  fastapi: ['FastAPI'],
  django: ['Django'],
  flask: ['Flask'],
  starlette: ['Starlette'],
  uvicorn: ['Uvicorn'],
  gunicorn: ['Gunicorn'],
  pandas: ['pandas'],
  numpy: ['NumPy'],
  scipy: ['SciPy'],
  'scikit-learn': ['scikit-learn'],
  torch: ['PyTorch'],
  pytorch: ['PyTorch'],
  tensorflow: ['TensorFlow'],
  jax: ['JAX'],
  transformers: ['Hugging Face'],
  datasets: ['Hugging Face'],
  anthropic: ['Anthropic API'],
  llama_index: ['LlamaIndex'],
  sqlalchemy: ['SQLAlchemy'],
  pydantic: ['Pydantic'],
  alembic: ['Alembic'],
  celery: ['Celery'],
  pytest: ['pytest'],
  ruff: ['Ruff'],
  black: ['Black'],
  mypy: ['mypy'],
  poetry: ['Poetry'],
  streamlit: ['Streamlit'],
  gradio: ['Gradio'],
  beautifulsoup4: ['BeautifulSoup'],
  scrapy: ['Scrapy'],
  selenium: ['Selenium'],
  playwright: ['Playwright'],
  boto3: ['AWS'],
  'google-cloud-storage': ['Google Cloud'],
  psycopg2: ['PostgreSQL'],
  'psycopg2-binary': ['PostgreSQL'],
  asyncpg: ['PostgreSQL'],
  pymongo: ['MongoDB'],
  httpx: ['httpx'],
  requests: ['requests'],

  // Go
  'github.com/gin-gonic/gin': ['Gin'],
  'github.com/labstack/echo': ['Echo'],
  'github.com/gofiber/fiber': ['Fiber'],
  'github.com/gorilla/mux': ['gorilla/mux'],
  'gorm.io/gorm': ['GORM'],
  'github.com/jmoiron/sqlx': ['sqlx'],
  'github.com/redis/go-redis': ['Redis'],
  'github.com/lib/pq': ['PostgreSQL'],
  'github.com/jackc/pgx': ['PostgreSQL'],
  'github.com/spf13/cobra': ['Cobra CLI'],
  'github.com/stretchr/testify': ['testify'],
  'google.golang.org/grpc': ['gRPC'],
  'github.com/aws/aws-sdk-go': ['AWS'],

  // Rust
  tokio: ['Tokio'],
  axum: ['Axum'],
  actix: ['Actix'],
  'actix-web': ['Actix'],
  rocket: ['Rocket'],
  serde: ['Serde'],
  sqlx: ['SQLx'],
  diesel: ['Diesel'],
  clap: ['Clap CLI'],
  reqwest: ['reqwest'],
  anyhow: ['anyhow'],
  thiserror: ['thiserror'],
  rayon: ['Rayon'],
  tracing: ['tracing'],
  'wasm-bindgen': ['WebAssembly'],
  wasm_bindgen: ['WebAssembly'],
};

/** Conventional files/folders that say something the manifests do not. */
async function detectMarkers(dir: string): Promise<string[]> {
  const checks: Array<{ marker: string; candidates: string[] }> = [
    {
      marker: 'docker',
      candidates: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml'],
    },
    { marker: 'ci', candidates: ['.github/workflows', '.gitlab-ci.yml', '.circleci', 'azure-pipelines.yml'] },
    {
      marker: 'tests',
      candidates: ['test', 'tests', '__tests__', 'spec', 'e2e', 'cypress', 'playwright.config.ts'],
    },
    { marker: 'monorepo', candidates: ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json', 'rush.json'] },
    { marker: 'docs', candidates: ['docs', 'documentation'] },
    { marker: 'infra', candidates: ['terraform', 'main.tf', 'k8s', 'helm', 'kubernetes', 'ansible'] },
    { marker: 'database', candidates: ['migrations', 'drizzle', 'prisma', 'alembic', 'schema.sql'] },
    { marker: 'notebooks', candidates: ['notebooks', 'jupyter'] },
    { marker: 'mobile', candidates: ['ios', 'android', 'flutter', 'pubspec.yaml'] },
    { marker: 'git', candidates: ['.git'] },
    { marker: 'env-config', candidates: ['.env.example', '.env.sample', 'config', 'config.toml'] },
    { marker: 'license', candidates: ['LICENSE', 'LICENSE.md', 'COPYING'] },
  ];

  const markers: string[] = [];
  for (const check of checks) {
    for (const candidate of check.candidates) {
      try {
        await fs.access(path.join(dir, candidate));
        markers.push(check.marker);
        break;
      } catch {
        // Absent: keep looking at the other candidates.
      }
    }
  }
  return markers.sort((a, b) => a.localeCompare(b));
}

async function readReadmeFirstLine(dir: string, maxChars = 4000): Promise<string | null> {
  for (const name of ['README.md', 'readme.md', 'README.txt', 'README']) {
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      const text = stripBom(raw).slice(0, maxChars);
      for (const line of text.split('\n')) {
        const clean = line.replace(/^#+\s*/, '').trim();
        if (clean) return clean.slice(0, 200);
      }
    } catch {
      // Try the next spelling.
    }
  }
  return null;
}

/**
 * Walk the tree (bounded by depth and file count) and turn file extensions into
 * languages. This is the only signal that can catch a project with no manifest
 * at all, which is exactly the kind of folder a user points us at.
 */
async function countFiles(
  root: string,
  options: LocalScanOptions,
): Promise<{ languages: Array<{ language: string; files: number }>; fileCount: number }> {
  const maxDepth = options.maxDepth ?? 3;
  const maxFiles = options.maxFilesPerProject ?? 400;
  const counts = new Map<string, number>();
  let fileCount = 0;
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || fileCount >= maxFiles || options.signal?.aborted) return;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (fileCount >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const language = languageForFile(entry.name);
      if (!language) continue;
      fileCount += 1;
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  };

  await walk(root, 1);

  const languages = [...counts.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));

  if (truncated) {
    logger.debug({ root, maxFiles }, 'profile.localScan: file walk truncated at maxFilesPerProject');
  }

  return { languages, fileCount };
}

/** Extension to language name. Unknown extensions return `null` and are not counted. */
export function languageForFile(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  const base = path.basename(fileName).toLowerCase();

  if (base === 'dockerfile') return 'Docker';
  if (base === 'makefile') return 'Make';

  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'TypeScript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'JavaScript';
    case '.py':
    case '.pyi':
      return 'Python';
    case '.go':
      return 'Go';
    case '.rs':
      return 'Rust';
    case '.java':
      return 'Java';
    case '.kt':
    case '.kts':
      return 'Kotlin';
    case '.swift':
      return 'Swift';
    case '.rb':
      return 'Ruby';
    case '.php':
      return 'PHP';
    case '.cs':
      return 'C#';
    case '.c':
    case '.h':
      return 'C';
    case '.cpp':
    case '.cc':
    case '.hpp':
    case '.cxx':
      return 'C++';
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'Shell';
    case '.sql':
      return 'SQL';
    case '.ipynb':
      return 'Jupyter';
    case '.html':
    case '.htm':
      return 'HTML';
    case '.css':
    case '.scss':
    case '.sass':
    case '.less':
      return 'CSS';
    case '.vue':
      return 'Vue';
    case '.svelte':
      return 'Svelte';
    case '.dart':
      return 'Dart';
    case '.ex':
    case '.exs':
      return 'Elixir';
    case '.lua':
      return 'Lua';
    case '.md':
    case '.mdx':
      return 'Markdown';
    case '.yml':
    case '.yaml':
      return 'YAML';
    case '.toml':
      return 'TOML';
    case '.json':
      return 'JSON';
    default:
      return null;
  }
}

/**
 * Render the scan as prompt input for `extract.ts`. Deterministic, and compact
 * enough that a dozen projects still leave room in the token budget.
 */
export function renderLocalScanForPrompt(result: LocalScanResult): string {
  if (result.projects.length === 0) {
    return result.missingPaths.length > 0
      ? `No local projects could be read. Missing: ${result.missingPaths.join(', ')}`
      : 'No local project folders configured.';
  }

  const blocks: string[] = [];
  for (const project of result.projects) {
    const lines: string[] = [`### ${project.name}`, `Path: ${project.path}`];

    if (project.stacks.length > 0) lines.push(`Stacks: ${project.stacks.join(', ')}`);
    if (project.markers.length > 0) lines.push(`Markers: ${project.markers.join(', ')}`);

    for (const manifest of project.manifests) {
      if (manifest.dependencies.length > 0) {
        lines.push(`${manifest.file} dependencies: ${manifest.dependencies.join(', ')}`);
      }
      const scriptNames = Object.keys(manifest.scripts);
      if (scriptNames.length > 0) lines.push(`${manifest.file} scripts: ${scriptNames.join(', ')}`);
    }

    if (project.languages.length > 0) {
      lines.push(`Files by language: ${project.languages.map((l) => `${l.language} ${l.files}`).join(', ')}`);
    }
    lines.push(`Files counted: ${project.fileCount}`);
    if (project.readmeFirstLine) lines.push(`README: ${project.readmeFirstLine}`);
    if (project.lastModifiedAt) {
      lines.push(`Last modified: ${new Date(project.lastModifiedAt).toISOString().slice(0, 10)}`);
    }

    blocks.push(lines.join('\n'));
  }

  if (result.missingPaths.length > 0) {
    blocks.push(`Missing folders (ignored): ${result.missingPaths.join(', ')}`);
  }

  return blocks.join('\n\n');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
