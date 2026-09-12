import 'server-only';

import { z } from 'zod';

import {
  GLM_MODEL_ID,
  LENS_PROMPTS,
  ME_AGENT_FALLBACK_NAME,
  ME_AGENT_FINISH_INSTRUCTION,
  renderSystemContract,
} from '@/lib/agents/defaults';
import { resolveAdapter } from '@/lib/llm/registry';
import { schemaPromptText } from '@/lib/orchestrator/schemas';
import { getActiveProfile, listProfileItems } from '@/lib/db/queries/profile';
import { getDb } from '@/lib/db/client';
import { activeItems, renderProfileViews, type SummaryItem } from '@/lib/profile/summary';
import { currentUserId, fail, ok, parseBody } from '../../_lib/http';

/**
 * `POST /api/profile/test` — one Me Agent proposal call against the current
 * unsaved draft, so the user sees the effect of their edits immediately
 * (section 10.6). Never touches the run tables: it is a preview, not a run.
 */

const itemSchema = z.object({
  kind: z.enum([
    'skill',
    'project',
    'taste',
    'experience',
    'constraint',
    'goal',
    'anti_pattern',
  ]),
  label: z.string().min(1),
  detail: z.string().default(''),
  source: z
    .enum(['github', 'cv', 'local_scan', 'notes', 'inferred', 'manual'])
    .default('manual'),
  confidence: z.number().min(0).max(1).default(1),
  orderIndex: z.number().int().default(0),
  stale: z.boolean().optional(),
});

const testSchema = z
  .object({
    profileDraft: z
      .object({
        items: z.array(itemSchema).max(200),
      })
      .optional(),
    seedPrompt: z.string().trim().min(1).max(500).optional(),
  })
  .default({});

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(request, testSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // The draft under test: the posted items, or the active profile when none
  // were posted. A preview of nothing is still useful — it shows the exact
  // "(no profile)" text the agents would receive.
  let items: SummaryItem[];
  if (body.profileDraft) {
    items = body.profileDraft.items;
  } else {
    const db = getDb();
    const profile = getActiveProfile(db);
    items = profile ? listProfileItems(db, profile.id) : [];
  }

  const views = renderProfileViews(activeItems(items));

  // Section 9.1, the four layers, assembled exactly as the orchestrator does
  // for the Me Agent seat so the preview cannot drift from the real thing.
  const contract = [
    renderSystemContract(ME_AGENT_FALLBACK_NAME, 'propose'),
    '',
    'Output format. Return a single JSON object and nothing else, matching this shape exactly:',
    schemaPromptText('propose'),
  ].join('\n');
  const author = [
    'Author profile (full summary):',
    views.summaryText,
    '',
    ME_AGENT_FINISH_INSTRUCTION,
  ].join('\n');
  const task =
    `Seed: ${body.seedPrompt ?? 'a small project this person can finish in two weeks'}. ` +
    'Seed mode: specific. Author brief: (preview run). Propose 1 idea from your lens. ' +
    'Return the propose JSON.';

  try {
    const adapter = resolveAdapter('glm');
    const result = await adapter.complete(
      {
        provider: 'glm',
        modelId: GLM_MODEL_ID,
        messages: [
          { role: 'system', content: contract },
          { role: 'system', content: LENS_PROMPTS.seat_me },
          { role: 'system', content: author },
          { role: 'user', content: task },
        ],
        temperature: 0.5,
        maxTokens: 800,
        jsonMode: true,
        reasoning: true,
        label: 'profile-test',
      },
      new AbortController().signal,
    );

    return ok({
      text: result.contentText || result.reasoningText,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
      profile: views,
    });
  } catch (err) {
    return fail(
      'PROFILE_TEST_FAILED',
      `The Me Agent test call failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
}
