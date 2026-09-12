import 'server-only';

import { sql } from 'drizzle-orm';

import { providerPresence } from '@/lib/config';
import { getDb } from '@/lib/db/client';
import type { HealthResponse } from '@/shared/types';
import { ok } from '../_lib/http';

/**
 * `GET /api/health` (section 14). Provider keys are checked for PRESENCE only,
 * never values; the DB check is a real round trip.
 */

export async function GET(): Promise<Response> {
  let dbOk = false;
  try {
    getDb().run(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const body: HealthResponse = {
    ok: dbOk,
    db: dbOk,
    providers: {
      ...providerPresence(),
      deepseek: { configured: false, baseUrl: 'retired 2026-09-11' },
    } as HealthResponse['providers'],
  };

  return ok(body, dbOk ? 200 : 503);
}
