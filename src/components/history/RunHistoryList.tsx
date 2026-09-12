'use client';

import { ArrowRight, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { RunSummary } from '@/shared/events';
import { RUN_STATUSES, type RunStatus } from '@/shared/constants';
import { formatDateTime, formatDuration, formatUsd, humanise, truncate } from '@/lib/utils';

/**
 * Run history, section 18.1.
 *
 * "`/runs` lists runs newest first with seed prompt, created date, status,
 *  winner title, winning score, cost, and duration. Filters by status and by
 *  seed-prompt substring. Clicking a row opens `/runs/[id]`."
 *
 * The status filter is a server query param (it changes which rows exist); the
 * seed substring is applied over the page the server returned, because a
 * substring search across every page would need a second round trip per
 * keystroke and the page size is bounded.
 */

export type StatusFilter = RunStatus | 'all';

export interface RunHistoryListProps {
  runs: RunSummary[];
  status: StatusFilter;
  onStatusChange: (status: StatusFilter) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onDelete: (id: string) => void;
  deletingId: string | null;
  /** Total rows before the client-side substring filter. */
  total: number;
  loading: boolean;
}

const STATUS_TONE: Record<RunStatus, NonNullable<BadgeProps['tone']>> = {
  created: 'neutral',
  running: 'accent',
  paused: 'warn',
  completed: 'ok',
  failed: 'danger',
  aborted: 'warn',
};

export function RunHistoryList({
  runs,
  status,
  onStatusChange,
  query,
  onQueryChange,
  onDelete,
  deletingId,
  total,
  loading,
}: RunHistoryListProps) {
  const router = useRouter();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const filtered = query.trim()
    ? runs.filter((run) => run.seedPrompt.toLowerCase().includes(query.trim().toLowerCase()))
    : runs;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
          <Label htmlFor="run-search">Filter by seed prompt</Label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-mute)]"
            />
            <Input
              id="run-search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Substring of the seed prompt"
              className="pl-8"
            />
          </div>
        </div>

        <div className="flex w-[13rem] flex-col gap-1.5">
          <Label htmlFor="run-status">Status</Label>
          <Select value={status} onValueChange={(v) => onStatusChange(v as StatusFilter)}>
            <SelectTrigger id="run-status" aria-label="Filter by status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {RUN_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {humanise(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className="tnum pb-2 text-[11.5px] text-[var(--text-mute)]">
          {filtered.length === total
            ? `${total} run${total === 1 ? '' : 's'} on this page`
            : `${filtered.length} of ${total} on this page`}
        </p>
      </div>

      {loading ? (
        <p className="py-10 text-center text-[13px] text-[var(--text-mute)]">Loading runs…</p>
      ) : filtered.length === 0 ? (
        <EmptyState hasRuns={total > 0} onClear={() => {
          onQueryChange('');
          onStatusChange('all');
        }} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-[var(--line)]">
                <Th className="pl-3">Seed prompt</Th>
                <Th className="hidden md:table-cell">Created</Th>
                <Th>Status</Th>
                <Th className="hidden lg:table-cell">Winner</Th>
                <Th className="text-right">Score</Th>
                <Th className="hidden sm:table-cell text-right">Cost</Th>
                <Th className="hidden sm:table-cell text-right">Duration</Th>
                <Th className="pr-3 text-right">
                  <span className="sr-only-live">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((run) => {
                const confirming = confirmingId === run.id;
                const deleting = deletingId === run.id;
                return (
                  <tr
                    key={run.id}
                    onClick={() => router.push(`/runs/${run.id}`)}
                    className="cursor-pointer border-b border-[var(--line)] transition-colors
                               last:border-b-0 hover:bg-[var(--bg-elev-2)]"
                  >
                    <td className="max-w-[26rem] py-2.5 pl-3 pr-3">
                      {/* The link is the row's keyboard entry point; the row
                          click is a convenience on top of it, never the only
                          way in (section 16.12). */}
                      <Link
                        href={`/runs/${run.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="block truncate text-[13px] text-[var(--text)] hover:text-[var(--gold-hi)]"
                      >
                        {truncate(run.seedPrompt, 110)}
                      </Link>
                      <p className="tnum mt-0.5 text-[11px] text-[var(--text-mute)] md:hidden">
                        {formatDateTime(run.createdAt)}
                      </p>
                    </td>

                    <td className="hidden whitespace-nowrap px-3 py-2.5 text-[12px] text-[var(--text-dim)] md:table-cell">
                      <span className="tnum">{formatDateTime(run.createdAt)}</span>
                    </td>

                    <td className="px-3 py-2.5">
                      <Badge tone={STATUS_TONE[run.status]}>{humanise(run.status)}</Badge>
                    </td>

                    <td className="hidden max-w-[18rem] px-3 py-2.5 lg:table-cell">
                      <span className="block truncate text-[12.5px] text-[var(--text-dim)]">
                        {run.winnerTitle ? truncate(run.winnerTitle, 60) : '—'}
                      </span>
                    </td>

                    <td className="tnum px-3 py-2.5 text-right text-[12.5px] font-medium text-[var(--text)]">
                      {run.winnerScore != null ? run.winnerScore.toFixed(3) : '—'}
                    </td>

                    <td className="tnum hidden whitespace-nowrap px-3 py-2.5 text-right text-[12.5px] text-[var(--text-dim)] sm:table-cell">
                      {formatUsd(run.costEstimateUsd)}
                    </td>

                    <td className="tnum hidden whitespace-nowrap px-3 py-2.5 text-right text-[12.5px] text-[var(--text-dim)] sm:table-cell">
                      {formatDuration(run.durationMs)}
                    </td>

                    <td className="whitespace-nowrap py-2.5 pl-3 pr-3 text-right">
                      <div
                        className="flex items-center justify-end gap-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {confirming ? (
                          <>
                            <span className="text-[11.5px] text-[var(--text-dim)]">Delete?</span>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={deleting}
                              onClick={() => {
                                setConfirmingId(null);
                                onDelete(run.id);
                              }}
                            >
                              {deleting ? 'Deleting…' : 'Confirm'}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setConfirmingId(null)}>
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button variant="ghost" size="sm" asChild>
                              <Link href={`/runs/${run.id}`}>
                                Open
                                <ArrowRight className="h-3.5 w-3.5" />
                              </Link>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete run: ${truncate(run.seedPrompt, 50)}`}
                              onClick={() => setConfirmingId(run.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`step-label px-3 py-2 font-medium text-[var(--text-mute)] ${className}`}
    >
      {children}
    </th>
  );
}

function EmptyState({ hasRuns, onClear }: { hasRuns: boolean; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-[var(--line-strong)] px-6 py-14 text-center">
      {/* Eight ticks around a ring, echoing the product mark. */}
      <svg width="34" height="34" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7" fill="none" stroke="var(--line-strong)" strokeWidth="1" />
        {Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
          return (
            <circle
              key={i}
              cx={10 + 7 * Math.cos(a)}
              cy={10 + 7 * Math.sin(a)}
              r="1.7"
              fill={`var(--seat-${i + 1})`}
              opacity="0.45"
            />
          );
        })}
      </svg>
      <p className="text-[14px] font-medium text-[var(--text)]">
        {hasRuns ? 'No runs match this filter' : 'No runs yet'}
      </p>
      <p className="max-w-[42ch] text-[12.5px] leading-relaxed text-[var(--text-dim)]">
        {hasRuns
          ? 'Try a different status or clear the seed-prompt filter.'
          : 'Put a question to the table and the whole debate — every proposal, critique, vote and the dissent — is stored here, replayable without spending a cent.'}
      </p>
      {hasRuns ? (
        <Button variant="secondary" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      ) : (
        <Button variant="primary" size="sm" asChild>
          <Link href="/run">Go to the table</Link>
        </Button>
      )}
    </div>
  );
}
