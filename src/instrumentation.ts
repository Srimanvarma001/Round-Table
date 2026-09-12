/**
 * Server boot hook, section 17.6.
 *
 * In-flight runs do not survive a hard restart in v1: any row left in
 * `running` with no live orchestrator is marked `failed` with
 * `PROCESS_RESTART`. All artefacts up to that point are preserved, so the run
 * stays browsable and replayable. `paused` rows are left alone — a resume can
 * still re-enter their step.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getDb, tablesExist } = await import('@/lib/db/client');
    if (!tablesExist()) return;
    const { sweepStaleRuns } = await import('@/lib/db/queries/runs');
    const { logger } = await import('@/lib/logger');
    try {
      const swept = sweepStaleRuns(getDb());
      if (swept > 0) logger.warn({ swept }, 'instrumentation: swept stale running runs');
    } catch (err) {
      logger.warn({ err }, 'instrumentation: boot sweep failed; continuing anyway');
    }
  }
}
