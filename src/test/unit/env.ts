/**
 * Unit-test environment for suites that touch the database. Imported FIRST so
 * the assignments land before `src/lib/config.ts` evaluates.
 *
 * Each test FILE gets a fresh worker registry and therefore its own temporary
 * SQLite file: no unit test ever touches `data/roundtable.db`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-unit-'));
const file = path.join(dir, 'roundtable.db');

process.env.DATABASE_URL = `file:${file}`;
process.env.APP_USER_ID = 'unit-user';
process.env.MOCK_LLM = 'true';
process.env.SEARCH_PROVIDER = 'stub';
process.env.GLM_API_KEY = '';
process.env.TAVILY_API_KEY = '';

export const UNIT_DB_FILE = file;
export const UNIT_DB_DIR = dir;
