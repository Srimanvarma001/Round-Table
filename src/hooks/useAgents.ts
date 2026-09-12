'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { AgentDTO, AgentsResponse } from '@/shared/types';

/** Agents are seeded server-side, so the editor always has data to render. */

async function fetchAgents(): Promise<AgentsResponse> {
  const res = await fetch('/api/agents', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load seats (${res.status})`);
  return (await res.json()) as AgentsResponse;
}

export function useAgents() {
  const query = useQuery({
    queryKey: ['agents'],
    queryFn: fetchAgents,
    staleTime: 30_000,
  });

  const agents: AgentDTO[] = (query.data?.agents ?? [])
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex);

  return {
    ...query,
    agents,
    normalisedWeights: query.data?.normalisedWeights ?? {},
  };
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<AgentDTO> }) => {
      const res = await fetch(`/api/agents/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Failed to save seat (${res.status})`);
      }
      return (await res.json()) as { agent: AgentDTO };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

/**
 * Weight editing is the one change that must be visible the instant it is made,
 * so the normalised-weight preview updates live (section 12.1). The server
 * returns the recomputed set with every write.
 */
export function useNormalisedPreview(agents: AgentDTO[]): Record<string, number> {
  const enabled = agents.filter((a) => a.enabled);
  const total = enabled.reduce((sum, a) => sum + Math.max(0, a.weight), 0);
  const out: Record<string, number> = {};
  for (const a of agents) {
    out[a.id] = !a.enabled || total <= 0 ? 0 : Math.max(0, a.weight) / total;
  }
  return out;
}
