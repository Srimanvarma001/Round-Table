import 'server-only';

import { z } from 'zod';

import { getDb } from '@/lib/db/client';
import { createRun, countRuns, listRuns } from '@/lib/db/queries/runs';
import { getSettingsOrDefaults } from '@/lib/db/queries/settings';
import { getMeAgent } from '@/lib/db/queries/agents';
import { buildAgentSnapshot, currentUserId, fail, ok, parseBody, toRunSummary } from '../_lib/http';

/**
 * `GET /api/runs` — history list (section 18.1), and `POST /api/runs` — create
 * a run without starting it (section 14).
 */

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z
    .enum(['created', 'running', 'paused', 'completed', 'failed', 'aborted'])
    .optional(),
  seed: z.string().max(300).optional(),
});

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = listSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return fail('INVALID_QUERY', 'One of the query parameters is invalid.');
  }

  const db = getDb();
  const rows = listRuns(db, {
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    status: parsed.data.status,
    seedContains: parsed.data.seed,
    userId: currentUserId(),
  });

  return ok({
    runs: rows.map(toRunSummary),
    total: countRuns(db, {
      status: parsed.data.status,
      seedContains: parsed.data.seed,
      userId: currentUserId(),
    }),
  });
}

const createSchema = z.object({
  seedPrompt: z.string().trim().min(1, 'A seed prompt is required.').max(2000),
  seedMode: z.enum(['vague', 'specific']).optional(),
  refineEnabled: z.boolean().optional(),
  budgetUsd: z.number().positive().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(request, createSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const db = getDb();
  const user = currentUserId();
  const me = getMeAgent(db);
  if (!me) {
    return fail('INTERNAL', 'No seats are seeded yet; run `pnpm seed` first.', 503);
  }

  // The snapshot is frozen at creation: later edits on /agents must not
  // rewrite a run that already began (section 7.5).
  const { snapshot } = buildAgentSnapshot();
  const settings = getSettingsOrDefaults(db);

  const run = createRun(db, {
    userId: user,
    seedPrompt: body.seedPrompt,
    seedMode: body.seedMode ?? 'specific',
    status: 'created',
    currentStep: 'propose',
    stepIndex: 0,
    round: 1,
    agentSnapshot: snapshot,
    configSnapshot: {
      // The six frozen fields of section 7.5. The operational knobs (retries,
      // concurrency, timeout) stay live in the settings table by design
      // (section 17.1) and the engine reads them from there.
      budgetUsd: body.budgetUsd ?? settings.budgetUsd,
      maxTokens: settings.maxTokens,
      maxCalls: settings.maxCalls,
      staggerCadenceMs: settings.staggerCadenceMs,
      refineEnabled: body.refineEnabled ?? settings.refineEnabled,
      searchEnabled: true,
    },
    profileId: null,
    tokensIn: 0,
    tokensOut: 0,
    costEstimateUsd: 0,
    llmCalls: 0,
    pauseRequested: false,
  });

  return ok({ runId: run.id, status: run.status }, 201);
}
