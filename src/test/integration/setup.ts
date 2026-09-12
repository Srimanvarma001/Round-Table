/**
 * Integration-test environment. Imported FIRST by every integration suite, so
 * these assignments run before `src/lib/config.ts` evaluates (it reads
 * `process.env` at import time).
 *
 * Every suite gets a fresh temporary SQLite file: no integration test ever
 * touches the developer's `data/roundtable.db`. `MOCK_LLM=true` keeps every
 * suite token-free; the registry's memoised mock is reconfigured per case via
 * `configure()` / `setScript()`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-int-'));
const file = path.join(dir, 'roundtable.db');

process.env.DATABASE_URL = `file:${file}`;
process.env.APP_USER_ID = 'int-user';
process.env.MOCK_LLM = 'true';
process.env.SEARCH_PROVIDER = 'stub';
process.env.RUN_BUDGET_USD = '10';
process.env.RUN_MAX_TOKENS = '1000000';
process.env.RUN_MAX_CALLS = '500';
process.env.GLM_API_KEY = '';
process.env.TAVILY_API_KEY = '';
process.env.GITHUB_TOKEN = '';
process.env.GITHUB_USERNAME = '';

export const INT_DB_FILE = file;
export const INT_DB_DIR = dir;
