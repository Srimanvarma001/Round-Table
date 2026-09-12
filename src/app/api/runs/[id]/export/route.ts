import 'server-only';

import { getDb } from '@/lib/db/client';
import { getRun } from '@/lib/db/queries/runs';
import { renderRunJson } from '@/lib/export/json';
import { renderRunMarkdown } from '@/lib/export/markdown';
import { buildRunDetail, fail } from '../../../_lib/http';

/**
 * `GET /api/runs/:id/export?format=md|json` — section 18.3. The markdown is a
 * standalone readable document; the JSON round-trips the full run detail.
 */

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const run = getRun(getDb(), id);
  if (!run) return fail('NOT_FOUND', `Run ${id} does not exist.`, 404);

  const format = new URL(request.url).searchParams.get('format') === 'json' ? 'json' : 'md';
  const detail = buildRunDetail(run, false);
  const stamp = new Date(run.createdAt).toISOString().slice(0, 10);

  if (format === 'json') {
    return new Response(JSON.stringify(renderRunJson(detail), null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="roundtable-run-${id.slice(0, 8)}-${stamp}.json"`,
      },
    });
  }

  return new Response(renderRunMarkdown(detail), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="roundtable-run-${id.slice(0, 8)}-${stamp}.md"`,
    },
  });
}
