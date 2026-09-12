/**
 * Seed the local database: the single user, the eight default seats, and the
 * token price table (sections 5, 7.4, 7.12, M1).
 *
 * Idempotent: missing rows are inserted, existing rows are left alone, so
 * re-running after seats were tuned in the UI never clobbers those edits.
 * (Deliberately not an upsert of the lens prompts: the UI owns seats after
 * first seed, and a reseed that rewrote prompts would destroy tuning work.)
 */

import './env';

import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_SEATS, ME_AGENT_FALLBACK_NAME } from '@/lib/agents/defaults';
import { renderSeatAvatar } from '@/lib/avatars/dicebear';
import { config, getDb } from '@/lib/db/client';
import { getAgentBySeatKey, createAgent } from '@/lib/db/queries/agents';
import { upsertPricingMany } from '@/lib/db/queries/pricing';
import { users } from '@/lib/db/schema';
import { DEFAULT_PRICING, PRICING_CHECKED_AT_ISO } from '@/lib/llm/pricing';
import { eq } from 'drizzle-orm';

import { runMigrations } from './migrate';

const TASTE_TEMPLATE = `# Taste notes

Hand-written notes for the Me Agent. Anything here is passed through largely
verbatim and chunked into profile items on the next regeneration
(\`pnpm ingest-profile\` or the Regenerate button on /profile).

Write what you like building, what you abandon, and what "good" looks like.
Lines starting with # are ignored.

- I like:
- I abandon:
- I want:
- I refuse:
`;

function ensureDataDirs(): void {
  for (const dir of ['data', 'data/uploads', 'data/notes', 'data/cache']) {
    fs.mkdirSync(path.join(process.cwd(), dir), { recursive: true });
  }
  for (const keep of ['data/.gitkeep', 'data/uploads/.gitkeep', 'data/notes/.gitkeep']) {
    const file = path.join(process.cwd(), keep);
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  }
  const taste = path.join(process.cwd(), 'data', 'notes', 'taste.md');
  if (!fs.existsSync(taste)) fs.writeFileSync(taste, TASTE_TEMPLATE);
}

async function main(): Promise<void> {
  const applied = runMigrations();
  if (applied.length > 0) console.log(`seed: applied migration(s): ${applied.join(', ')}`);

  ensureDataDirs();

  const db = getDb();
  const userId = config.APP_USER_ID;

  const existingUser = db.select().from(users).where(eq(users.id, userId)).get();
  if (!existingUser) {
    db.insert(users)
      .values({ id: userId, displayName: ME_AGENT_FALLBACK_NAME, createdAt: Date.now() })
      .run();
    console.log(`seed: created user "${userId}"`);
  } else {
    console.log(`seed: user "${userId}" already exists`);
  }

  let created = 0;
  for (const seat of DEFAULT_SEATS) {
    const existing = getAgentBySeatKey(db, seat.seatKey);
    if (existing) continue;
    createAgent(db, {
      userId,
      seatKey: seat.seatKey,
      name: seat.name,
      isMeAgent: seat.isMeAgent,
      lensPrompt: seat.lensPrompt,
      provider: seat.provider,
      modelId: seat.modelId,
      temperature: seat.temperature,
      weight: seat.weight,
      avatarStyle: seat.avatarStyle,
      avatarSeed: seat.avatarSeed,
      avatarSvgCache: renderSeatAvatar({
        style: seat.avatarStyle,
        seed: seat.avatarSeed,
        accent: seat.accentColor,
        name: seat.name,
        iconName: seat.iconName,
      }),
      accentColor: seat.accentColor,
      accentToken: seat.accentToken,
      iconName: seat.iconName,
      enabled: seat.enabled,
      orderIndex: seat.orderIndex,
    });
    created += 1;
  }
  console.log(`seed: inserted ${created} seat(s), ${DEFAULT_SEATS.length - created} already present`);

  const pricing = upsertPricingMany(db, DEFAULT_PRICING);
  console.log(`seed: wrote ${pricing} pricing row(s) (checked ${PRICING_CHECKED_AT_ISO})`);
}

main().catch((err) => {
  console.error(`seed: FAILED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
