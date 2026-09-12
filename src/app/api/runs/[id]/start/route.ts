import 'server-only';

import { eq } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { getRun, updateRun } from '@/lib/db/queries/runs';
import { launchRun } from '@/lib/orchestrator/engine';
import { fail, ok } from '../../../_lib/http';

/**
 * `POST /api/runs/:id/start` — begins the loop. Idempotent: starting a running
 * run is a no-op, and starting a paused run resumes it (section 14).
 */

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const db = getDb();
  const run = getRun(db, id);
  if (!run) return fail('NOT_FOUND', `Run ${id} does not exist.`, 404);

  // Terminal states stay terminal; the client creates a new run instead.
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'aborted') {
    return fail('INVALID_TRANSITION', `Run ${id} is already ${run.status}.`, 409);
  }

  if (run.status === 'created') {
    updateRun(db, id, { status: 'running', startedAt: Date.now() });
  } else if (run.status === 'paused') {
    // A start on a paused run IS a resume (section 14: idempotent start).
    updateRun(db, id, { status: 'running' });
  }
  void eq; // imported for parity with the other handlers

  const launched = launchRun(id);
  // Double-start in this process: the first engine is still attached, which is
  // exactly the idempotency the contract asks for.
  void launched;

  const status = getRun(db, id)?.status ?? 'running';
  return ok({ status }, 202);
}
