import 'server-only';

import { z } from 'zod';

import { PROFILE_PIPELINE_SOURCES, runProfilePipeline } from '@/lib/profile/pipeline';
import { currentUserId, fail, ok, parseBody } from '../../_lib/http';

/**
 * `POST /api/profile/ingest` — run ONE ingestor and return a draft (section
 * 14). A thin wrapper over the full pipeline restricted to a single source:
 * the merge rule (section 10.4) is identical, so a single-source ingest still
 * preserves locked and manual items and still produces a draft, never an
 * activation.
 */

const ingestSchema = z.object({
  source: z.enum(PROFILE_PIPELINE_SOURCES),
  force: z.boolean().optional(),
  cvPath: z.string().trim().optional(),
  localPaths: z.array(z.string().trim().min(1)).optional(),
  notesPath: z.string().trim().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(request, ingestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  try {
    const result = await runProfilePipeline({
      sources: [body.source],
      userId: currentUserId(),
      options: {
        force: body.force,
        cvPath: body.cvPath,
        localPaths: body.localPaths,
        notesPath: body.notesPath,
      },
    });

    return ok({
      draftId: result.draftId,
      itemCount: result.itemCount,
      warnings: result.warnings,
      version: result.version,
      diff: result.diff,
      ingestRuns: result.ingestRuns,
    });
  } catch (err) {
    return fail(
      'PROFILE_PIPELINE',
      `The ${body.source} ingest failed: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}
