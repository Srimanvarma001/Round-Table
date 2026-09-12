import 'server-only';

import { getDb } from '@/lib/db/client';
import { getRun } from '@/lib/db/queries/runs';
import { buildRunCompare, fail, ok } from '../../_lib/http';

/**
 * `GET /api/runs/compare?a=&b=` — two runs side by side with the section 12.5
 * deltas (section 18.4).
 */

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const a = url.searchParams.get('a');
  const b = url.searchParams.get('b');

  if (!a || !b) return fail('INVALID_QUERY', 'Both `a` and `b` run ids are required.');
  if (a === b) return fail('INVALID_QUERY', 'Pick two different runs to compare.');

  const db = getDb();
  const runA = getRun(db, a);
  const runB = getRun(db, b);
  if (!runA) return fail('NOT_FOUND', `Run ${a} does not exist.`, 404);
  if (!runB) return fail('NOT_FOUND', `Run ${b} does not exist.`, 404);

  return ok(buildRunCompare(runA, runB));
}
