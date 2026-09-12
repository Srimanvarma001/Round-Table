import 'server-only';

import { getDb, nowMs } from '@/lib/db/client';
import { getRun, updateRun } from '@/lib/db/queries/runs';
import { getRunEventBus } from '@/lib/orchestrator/bus';
import { isRunActive } from '@/lib/orchestrator/engine';
import { emit } from '@/lib/orchestrator/bus';
import { fail, ok } from '../../../_lib/http';

/**
 * `POST /api/runs/:id/abort` — terminal, keeps data (section 14). In-flight
 * calls run to completion; no new task is dispatched after the flag.
 */

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  const run = getRun(db, id);
  if (!run) return fail('NOT_FOUND', `Run ${id} does not exist.`, 404);

  // Idempotent: aborting an aborted run is a no-op; aborting a finished run is
  // rejected rather than retroactively rewriting its outcome.
  if (run.status === 'aborted') return ok({ status: 'aborted' });
  if (run.status === 'completed' || run.status === 'failed') {
    return fail('INVALID_TRANSITION', `A ${run.status} run cannot be aborted.`, 409);
  }

  updateRun(db, id, {
    status: 'aborted',
    pauseRequested: false,
    completedAt: nowMs(),
  });

  if (isRunActive(id)) {
    // The engine observes the row flip and finalises: it emits `run.aborted`
    // after the in-flight tasks settle, so the client gets one coherent ending.
    return ok({ status: 'aborted' });
  }

  // No engine attached in this process (started elsewhere or before a reload):
  // finalise here so the event stream still gets its terminal event.
  const atStep = run.currentStep === 'done' ? 'reveal' : run.currentStep;
  await emit(getRunEventBus(), id, 'run.aborted', { atStep });
  return ok({ status: 'aborted' });
}
