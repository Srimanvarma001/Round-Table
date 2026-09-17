import 'server-only';

import { z } from 'zod';

import { renderSeatAvatar } from '@/lib/avatars/dicebear';
import { randomCharacterKey } from '@/lib/avatars/characters';
import { getDb } from '@/lib/db/client';
import { deleteAgent, getAgent, updateAgent } from '@/lib/db/queries/agents';
import { fail, ok, parseBody, toAgentDTO } from '../../_lib/http';

/**
 * `PUT /api/agents/:id` — edit a seat; `DELETE /api/agents/:id` — remove one.
 * Deleting the Me Agent seat is refused (section 14).
 */

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    lensPrompt: z.string().trim().min(1).max(4000).optional(),
    provider: z.enum(['glm', 'mock']).optional(),
    modelId: z.string().trim().min(1).max(120).optional(),
    temperature: z.number().min(0).max(2).optional(),
    weight: z.number().min(0).max(10).optional(),
    avatarStyle: z.enum(['dicebear', 'lucide', 'initials', 'pixel']).optional(),
    avatarSeed: z.string().trim().min(1).max(120).optional(),
    iconName: z.string().trim().min(1).max(60).optional(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    accentToken: z.string().regex(/^--seat-[1-8]$/).optional(),
    enabled: z.boolean().optional(),
    isMeAgent: z.boolean().optional(),
    /** Regenerate the avatar from the current style + seed. */
    rerollAvatar: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update.' });

export async function PUT(request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const parsed = await parseBody(request, patchSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const db = getDb();

  const existing = getAgent(db, id);
  if (!existing) return fail('NOT_FOUND', `Seat ${id} does not exist.`, 404);

  const { rerollAvatar, ...patch } = body;
  const style = patch.avatarStyle ?? existing.avatarStyle;
  let seed = patch.avatarSeed ?? existing.avatarSeed;
  const accent = patch.accentColor ?? existing.accentColor;
  const icon = patch.iconName ?? existing.iconName;
  const name = patch.name ?? existing.name;

  if (rerollAvatar) {
    // A reroll must change what is rendered: both renders are deterministic
    // from the seed, so regenerating alone would be a no-op. A pixel seat
    // swaps to a different character; a dicebear seat takes a fresh seed.
    if (style === 'pixel') {
      seed = randomCharacterKey(existing.avatarSeed);
    } else if (style === 'dicebear') {
      seed = `${existing.seatKey}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    }
  }

  const updated = updateAgent(db, id, {
    ...patch,
    ...(rerollAvatar ? { avatarSeed: seed } : {}),
    // An avatar change (style, seed, reroll, or the accent it is drawn in)
    // regenerates the cached SVG; a pure text edit leaves it alone.
    avatarSvgCache:
      rerollAvatar || patch.avatarStyle !== undefined || patch.avatarSeed !== undefined || patch.accentColor !== undefined
        ? renderSeatAvatar({ style, seed, accent, name, iconName: icon })
        : existing.avatarSvgCache,
  });
  if (!updated) return fail('NOT_FOUND', `Seat ${id} does not exist.`, 404);

  // Section 7.4: exactly one Me Agent, enforced on every write.
  if (patch.isMeAgent === true) {
    const { ensureUniqueMeAgent } = await import('@/lib/db/queries/agents');
    ensureUniqueMeAgent(db, id);
  }

  return ok({ agent: toAgentDTO(updated) });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const result = deleteAgent(getDb(), id);

  if (!result.deleted) {
    if (result.reason === 'not_found') return fail('NOT_FOUND', `Seat ${id} does not exist.`, 404);
    return fail('ME_AGENT_DELETE', 'The Me Agent seat cannot be deleted.', 409);
  }
  return new Response(null, { status: 204 });
}
