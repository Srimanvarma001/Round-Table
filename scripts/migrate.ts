/**
 * Apply pending Drizzle SQL migrations to the SQLite file.
 *
 * Section 5: migrations are generated SQL under `drizzle/`, committed, so a
 * fresh clone reaches a working database with `pnpm db:migrate` alone.
 *
 * Deliberately dependency-light: it uses `better-sqlite3` and the filesystem
 * directly instead of importing `src/lib/*`, so migration never depends on
 * application code. Statements are split on drizzle-kit's
 * `--> statement-breakpoint` marker and applied inside one transaction per
 * file; applied files are recorded in `__drizzle_migrations`.
 *
 * Also exported as `runMigrations()` so `seed.ts` and the test harness can
 * guarantee a migrated database before touching any table.
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function databaseFile(): string {
  const url = process.env.DATABASE_URL ?? 'file:./data/roundtable.db';
  const raw = url.startsWith('file:') ? url.slice('file:'.length) : url;
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function drizzleDir(): string {
  return path.join(process.cwd(), 'drizzle');
}

function readJournal(): JournalEntry[] {
  const journalPath = path.join(drizzleDir(), 'meta', '_journal.json');
  const raw = fs.readFileSync(journalPath, 'utf8');
  const journal = JSON.parse(raw) as { entries: JournalEntry[] };
  return [...journal.entries].sort((a, b) => a.idx - b.idx);
}

function appliedTags(db: Database.Database): Set<string> {
  db.exec(
    `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )`,
  );
  const rows = db.prepare(`SELECT tag FROM __drizzle_migrations`).all() as Array<{ tag: string }>;
  return new Set(rows.map((r) => r.tag));
}

/** Run every migration in `drizzle/` not yet recorded. Returns tags applied. */
export function runMigrations(): string[] {
  const file = databaseFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    const done = appliedTags(db);
    const applied: string[] = [];

    for (const entry of readJournal()) {
      if (done.has(entry.tag)) continue;
      const sqlPath = path.join(drizzleDir(), `${entry.tag}.sql`);
      const sql = fs.readFileSync(sqlPath, 'utf8');
      const statements = sql
        .split(/-->\s*statement-breakpoint/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const apply = db.transaction(() => {
        for (const stmt of statements) db.exec(stmt);
        db.prepare(`INSERT INTO __drizzle_migrations (tag, applied_at) VALUES (?, ?)`).run(
          entry.tag,
          Date.now(),
        );
      });
      apply();
      applied.push(entry.tag);
    }

    return applied;
  } finally {
    db.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).endsWith(path.join('scripts', 'migrate.ts'));

if (invokedDirectly) {
  try {
    const applied = runMigrations();
    if (applied.length === 0) {
      console.log(`migrate: database is up to date (${databaseFile()})`);
    } else {
      console.log(`migrate: applied ${applied.length} migration(s) to ${databaseFile()}:`);
      for (const tag of applied) console.log(`  - ${tag}`);
    }
  } catch (err) {
    console.error(`migrate: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
