import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration (section 4.2).
 *
 * Migrations are generated as plain SQL files under `drizzle/` and committed,
 * so a fresh clone reaches a working database with `pnpm db:migrate` alone —
 * no `generate` step, and therefore no dependence on the schema file at
 * deploy time.
 *
 * The database URL is read from the environment here rather than from
 * `src/lib/config.ts` because drizzle-kit runs outside the Next.js server
 * runtime, where `import 'server-only'` throws. This is the one sanctioned
 * exception to the "config.ts is the only reader of process.env" rule, and it
 * reads a non-secret path only.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./data/roundtable.db',
  },
  strict: true,
  verbose: true,
});
