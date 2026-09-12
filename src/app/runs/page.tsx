'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, GitCompare, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { RunHistoryList, type StatusFilter } from '@/components/history/RunHistoryList';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Panel,
} from '@/components/ui/card';
import type { RunSummary } from '@/shared/events';

/**
 * Run history, section 18.1.
 *
 * TanStack Query owns this list (section 15.2): history is server data that is
 * not live, so it does not belong in the run reducer. The status filter and the
 * page window are query parameters the server applies; the seed-prompt prefix
 * is applied over the returned page, which keeps a keystroke off the network.
 */

const PAGE_SIZE = 50;

async function fetchRuns(params: {
  limit: number;
  offset: number;
  status: StatusFilter;
}): Promise<RunSummary[]> {
  const search = new URLSearchParams({
    limit: String(params.limit),
    offset: String(params.offset),
  });
  if (params.status !== 'all') search.set('status', params.status);

  const res = await fetch(`/api/runs?${search.toString()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load runs (${res.status})`);
  const data = (await res.json()) as { runs: RunSummary[] };
  return data.runs ?? [];
}

export default function RunsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);

  const runsQuery = useQuery({
    queryKey: ['runs', PAGE_SIZE, offset, status],
    queryFn: () => fetchRuns({ limit: PAGE_SIZE, offset, status }),
    staleTime: 15_000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/runs/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        throw new Error(`Failed to delete run (${res.status})`);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  const runs = runsQuery.data ?? [];
  const canGoBack = offset > 0;
  const canGoForward = runs.length === PAGE_SIZE;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display-face text-[var(--fs-h1)] font-semibold text-[var(--text)]">
            Run history
          </h1>
          <p className="mt-1 max-w-[70ch] text-[var(--fs-small)] text-[var(--text-dim)]">
            Every run the table has sat through, stored whole: the proposals, critiques, votes and
            the dissent. Any of them can be replayed without spending a cent.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="secondary" size="md" asChild>
            <Link href="/runs/compare">
              <GitCompare className="h-3.5 w-3.5" />
              Compare two runs
            </Link>
          </Button>
          <Button variant="primary" size="md" asChild>
            <Link href="/run">
              <Plus className="h-3.5 w-3.5" />
              New run
            </Link>
          </Button>
        </div>
      </div>

      <Panel className="px-5 py-5">
        {runsQuery.isError ? (
          <p
            role="alert"
            className="mb-4 rounded-[var(--radius-card)] border border-[var(--danger)]/40
                       bg-[var(--danger)]/10 px-3 py-2 text-[12.5px] text-[var(--danger)]"
          >
            {runsQuery.error instanceof Error
              ? runsQuery.error.message
              : 'Failed to load run history'}
          </p>
        ) : null}

        <RunHistoryList
          runs={runs}
          status={status}
          onStatusChange={(next) => {
            setStatus(next);
            setOffset(0);
          }}
          query={query}
          onQueryChange={setQuery}
          onDelete={(id) => deleteMutation.mutate(id)}
          deletingId={deleteMutation.isPending ? (deleteMutation.variables ?? null) : null}
          total={runs.length}
          loading={runsQuery.isPending}
        />

        {canGoBack || canGoForward ? (
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--line)] pt-3">
            <span className="tnum text-[11.5px] text-[var(--text-mute)]">
              rows {offset + 1}–{offset + runs.length}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={!canGoBack}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Newer
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!canGoForward}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                Older
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ) : null}
      </Panel>

      <Card>
        <CardHeader>
          <CardTitle>Replay is the demo mode</CardTitle>
          <CardDescription>
            A stored run re-emits its own event log into the same reducer the live table uses, on a
            timer, with a scrubber over the step boundaries. It reads rows and makes no model calls,
            so the product can be shown to anyone at any time without a budget.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" asChild>
            <Link href="/runs/compare">Compare two runs side by side</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
