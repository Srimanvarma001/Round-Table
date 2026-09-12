import 'server-only';

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { config, databaseFilePath } from '../config';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

interface DbGlobal {
  __roundtableDb?: Db;
  __roundtableRaw?: Database.Database;
}

// Next.js dev mode re-evaluates modules on every hot reload. Without this the
// process would open a new SQLite handle per edit until it ran out.
const g = globalThis as unknown as DbGlobal;

function createRaw(): Database.Database {
  const file = databaseFilePath();
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);

  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(abs);

  // Section 7.13. WAL keeps eight parallel writers from blocking each other;
  // foreign_keys is off by default in SQLite and has to be turned on per
  // connection.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}

export function rawDb(): Database.Database {
  if (!g.__roundtableRaw) g.__roundtableRaw = createRaw();
  return g.__roundtableRaw;
}

export function getDb(): Db {
  if (!g.__roundtableDb) g.__roundtableDb = drizzle(rawDb(), { schema });
  return g.__roundtableDb;
}

/** Tables that must exist before any query runs. Guarded by a marker table. */
export const REQUIRED_TABLES = [
  'users',
  'profiles',
  'profile_items',
  'agents',
  'runs',
  'proposals',
  'critiques',
  'votes',
  'run_events',
  'agent_messages',
  'settings',
  'model_pricing',
] as const;

export function tablesExist(): boolean {
  const rows = rawDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all() as Array<{ name: string }>;
  const present = new Set(rows.map((r) => r.name));
  return REQUIRED_TABLES.every((t) => present.has(t));
}

export function nowMs(): number {
  return Date.now();
}

export function newId(): string {
  return crypto.randomUUID();
}

export { config };
