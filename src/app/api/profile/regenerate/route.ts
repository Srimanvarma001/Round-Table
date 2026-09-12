import 'server-only';

import { z } from 'zod';

import { PROFILE_PIPELINE_SOURCES, runProfilePipeline } from '@/lib/profile/pipeline';
import { fail, ok, parseBody, currentUserId } from '../../_lib/http';

/**
 * `POST /api/profile/regenerate` — the full pipeline: ingest every selected
 * source, extract, merge (locked and manual items preserved), write a DRAFT at
 * the next version and return the diff for confirmation. Nothing is activated
 * here (section 10.4 rule 4).
 */

const regenerateSchema = z.object({
  sources: z.array(z.enum(PROFILE_PIPELINE_SOURCES)).min(1),
  force: z.boolean().optional(),
  cvPath: z.string().trim().optional(),
  localPaths: z.array(z.string().trim().min(1)).optional(),
  notesPath: z.string().trim().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(request, regenerateSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  try {
    const result = await runProfilePipeline({
      sources: body.sources,
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
      diff: result.diff,
      itemCount: result.itemCount,
      warnings: result.warnings,
      version: result.version,
    });
  } catch (err) {
    return fail(
      'PROFILE_PIPELINE',
      `The profile pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}
