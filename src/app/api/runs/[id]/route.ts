import 'server-only';

import { getDb } from '@/lib/db/client';
import { deleteRun, getRun } from '@/lib/db/queries/runs';
import { buildRunDetail, fail, ok } from '../../_lib/http';

/**
 * `GET /api/runs/:id` — the full run snapshot: the polling fallback, the replay
 * source and the reveal breakdown in one response (sections 14, 15.2, 18.2).
 * `DELETE /api/runs/:id` — delete with cascades.
 */

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const run = getRun(getDb(), id);
  if (!run) return fail('NOT_FOUND', `Run ${id} does not exist.`, 404);

  const withEvents = new URL(request.url).searchParams.get('events') === '1';
  return ok(buildRunDetail(run, withEvents));
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const deleted = deleteRun(getDb(), id);
  if (!deleted) return fail('NOT_FOUND', `Run ${id} does not exist.`, 404);
  return new Response(null, { status: 204 });
}
