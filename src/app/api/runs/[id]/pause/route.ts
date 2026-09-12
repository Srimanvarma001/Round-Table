import 'server-only';

import { getDb } from '@/lib/db/client';
import { getRun, updateRun } from '@/lib/db/queries/runs';
import { isRunActive } from '@/lib/orchestrator/engine';
import { fail, ok } from '../../../_lib/http';

/**
 * `POST /api/runs/:id/pause` — sets the pause flag. In-flight calls are never
 * aborted; the engine drains them and then parks the run (section 11.4).
 */

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  const run = getRun(db, id);
  if (!run) return fail('NOT_FOUND', `Run ${id} does not exist.`, 404);

  if (run.status === 'paused') {
    return ok({ status: 'paused' }, 202); // double-pause: already parked
  }
  if (run.status === 'created') {
    // Never started: pausing parks it directly; there is no engine to signal.
    updateRun(db, id, { status: 'paused' });
    return ok({ status: 'paused' }, 202);
  }
  if (run.status !== 'running') {
    return fail('INVALID_TRANSITION', `A ${run.status} run cannot be paused.`, 409);
  }

  updateRun(db, id, { pauseRequested: true });

  // If no engine is attached in this process (e.g. it was started before a
  // reload), the flag would never be observed — park it immediately.
  if (!isRunActive(id)) {
    updateRun(db, id, { status: 'paused' });
    return ok({ status: 'paused' }, 202);
  }

  return ok({ status: 'running' }, 202);
}
