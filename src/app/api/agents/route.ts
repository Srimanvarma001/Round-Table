import 'server-only';

import { z } from 'zod';

import { GLM_MODEL_ID } from '@/lib/agents/defaults';
import { normaliseWeights } from '@/lib/agents/weights';
import { renderSeatAvatar } from '@/lib/avatars/dicebear';
import { getDb, newId } from '@/lib/db/client';
import { createAgent, listAgents } from '@/lib/db/queries/agents';
import { buildAgentSnapshot, currentUserId, fail, ok, parseBody, toAgentDTO } from '../_lib/http';

/**
 * `GET /api/agents` — the seat list with the normalised-weight preview, and
 * `POST /api/agents` — add a seat (section 14). The Me Agent flag must stay
 * unique; a new seat may claim it, which clears it everywhere else.
 */

export async function GET(): Promise<Response> {
  const db = getDb();
  const rows = listAgents(db);
  const enabled = rows.filter((row) => row.enabled);

  let normalised: Record<string, number> = {};
  let totalRawWeight = 0;
  if (enabled.length > 0) {
    normalised = normaliseWeights(rows.map((row) => ({ id: row.id, weight: row.weight, enabled: row.enabled })));
    totalRawWeight = enabled.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
  }

  return ok({
    agents: rows.map(toAgentDTO),
    normalisedWeights: normalised,
    totalRawWeight,
  });
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  lensPrompt: z.string().trim().min(1).max(4000),
  provider: z.enum(['glm', 'mock']).default('glm'),
  modelId: z.string().trim().min(1).max(120).default(GLM_MODEL_ID),
  temperature: z.number().min(0).max(2).default(0.7),
  weight: z.number().min(0).max(10).default(0.75 / 7),
  avatarStyle: z.enum(['dicebear', 'lucide', 'initials']).default('dicebear'),
  avatarSeed: z.string().trim().max(120).optional(),
  iconName: z.string().trim().max(60).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#C9973F'),
  accentToken: z.string().regex(/^--seat-[1-8]$/).default('--seat-5'),
  isMeAgent: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseBody(request, createSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const db = getDb();

  const existing = listAgents(db);
  const nextOrder = existing.reduce((max, row) => Math.max(max, row.orderIndex), 0) + 1;
  const seatKey = `seat_custom_${Date.now().toString(36)}`;
  const avatarSeed = body.avatarSeed ?? `${seatKey}-${newId().slice(0, 6)}`;

  const agent = createAgent(db, {
    userId: currentUserId(),
    seatKey,
    name: body.name,
    isMeAgent: body.isMeAgent,
    lensPrompt: body.lensPrompt,
    provider: body.provider,
    modelId: body.modelId,
    temperature: body.temperature,
    weight: body.weight,
    avatarStyle: body.avatarStyle,
    avatarSeed,
    avatarSvgCache: renderSeatAvatar({
      style: body.avatarStyle,
      seed: avatarSeed,
      accent: body.accentColor,
      name: body.name,
      iconName: body.iconName ?? 'user-round',
    }),
    accentColor: body.accentColor,
    accentToken: body.accentToken,
    iconName: body.iconName ?? 'user-round',
    enabled: body.enabled,
    orderIndex: nextOrder,
  });

  // Section 7.4: exactly one Me Agent. A POST that claims the flag clears it
  // everywhere else, in the same tick.
  if (body.isMeAgent) {
    const { ensureUniqueMeAgent } = await import('@/lib/db/queries/agents');
    ensureUniqueMeAgent(db, agent.id);
  }

  return ok({ agent: toAgentDTO(agent) }, 201);
}
