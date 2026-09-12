import 'server-only';

import { getDb } from '@/lib/db/client';
import { getRun, updateRun } from '@/lib/db/queries/runs';
import { launchRun } from '@/lib/orchestrator/engine';
import { fail, ok } from '../../../_lib/http';

/**
 * `POST /api/runs/:id/resume` — clears the pause flag and re-enters the step.
 * Completed task keys are never re-requested (section 11.4 rule 3).
 */

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  const run = getRun(db, id);
  if (!run) return fail('NOT_FOUND', `Run ${id} does not exist.`, 404);

  if (run.status === 'running') {
    // Double-resume while an engine is already walking: a no-op, not an error.
    return ok({ status: 'running' }, 202);
  }
  if (run.status !== 'paused') {
    return fail('INVALID_TRANSITION', `A ${run.status} run cannot be resumed.`, 409);
  }

  updateRun(db, id, { status: 'running', pauseRequested: false });
  launchRun(id);

  return ok({ status: 'running' }, 202);
}
