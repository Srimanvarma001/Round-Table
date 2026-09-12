'use client';

import { useQuery } from '@tanstack/react-query';

import type { RunDetailResponse } from '@/shared/types';

/**
 * Polling fallback when SSE is unavailable, section 13.4.
 *
 * "The client MUST treat a close without a terminal event as a transport
 * failure and fall back to polling `GET /api/runs/:id` once before deciding
 * to reconnect."
 *
 * `useRunStream` owns the live path; this hook owns the fallback path. It
 * polls the full run snapshot on an interval while `enabled` and stops on the
 * first terminal status it observes.
 */
export const DEFAULT_POLL_INTERVAL_MS = 2500;

async function fetchRunDetail(runId: string): Promise<RunDetailResponse> {
  const res = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to poll run ${runId} (${res.status})`);
  return (await res.json()) as RunDetailResponse;
}

const TERMINAL = new Set(['completed', 'failed', 'aborted']);

export function useRunPolling({
  runId,
  enabled,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  runId: string | null;
  enabled: boolean;
  intervalMs?: number;
}) {
  const query = useQuery({
    queryKey: ['run-polling', runId],
    queryFn: () => fetchRunDetail(runId as string),
    enabled: enabled && runId !== null,
    refetchInterval: (query) => {
      const data = query.state.data as RunDetailResponse | undefined;
      const status = data?.run.status;
      return status && TERMINAL.has(status) ? false : intervalMs;
    },
    staleTime: 0,
    retry: 1,
  });

  return {
    ...query,
    detail: query.data ?? null,
  };
}
