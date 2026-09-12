'use client';

import { AlertTriangle, Check, CircleSlash, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { formatDateTime, formatDuration } from '@/lib/utils';
import type { IngestRunDTO } from '@/shared/types';

/**
 * Ingestion sources and their history, section 10.6.
 *
 * "Ingestion runs are recorded with timestamp, source, item counts, and any
 *  error, displayed as a history list so a failed GitHub fetch is visible
 *  rather than silent."
 *
 * That last clause is the reason this panel exists at all. A profile ingestor
 * that fails quietly is worse than one that fails loudly: the user would edit a
 * profile they believe was built from their repositories when it was in fact
 * built from nothing. So a failed run keeps its row, keeps its error text, and
 * is marked with the word "failed" as well as a tone — never with colour alone
 * (section 16.12).
 *
 * The source list is the section 10.1 table. `local_scan` is the only source
 * that needs an argument, so it is the only one that reveals an input.
 */

export const PROFILE_SOURCES = ['github', 'cv', 'local_scan', 'notes'] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];

const SOURCE_HELP: Record<ProfileSource, string> = {
  github: 'Repositories, languages, topics and the contribution calendar. Detects the shipped and abandoned signals the Mentor seat leans on.',
  cv: 'A PDF, DOCX, Markdown or plain-text CV placed in data/uploads/. One extraction pass to structured items.',
  local_scan: 'Folder paths on this machine. Reads manifests — package.json, pyproject.toml, go.mod, Cargo.toml — with no model call at all.',
  notes: 'Taste notes from data/notes/taste.md, passed through largely verbatim and chunked into items.',
};

export interface ProfileIngestPanelProps {
  ingestRuns: IngestRunDTO[];
  runningSource: ProfileSource | null;
  regenerating: boolean;
  warnings: string[];
  onIngest: (source: ProfileSource, options?: Record<string, unknown>) => void;
  onRegenerate: () => void;
}

export function ProfileIngestPanel({
  ingestRuns,
  runningSource,
  regenerating,
  warnings,
  onIngest,
  onRegenerate,
}: ProfileIngestPanelProps) {
  const [paths, setPaths] = useState('');

  const ordered = ingestRuns.slice().sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[52ch] text-[12px] leading-relaxed text-[var(--text-dim)]">
          Regeneration reads every source, extracts items, and merges them against this profile.
          Manual and locked items are copied through untouched — that is the guarantee that makes
          it safe to press (section 10.4).
        </p>
        <Button variant="primary" size="md" onClick={onRegenerate} disabled={regenerating}>
          {regenerating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {regenerating ? 'Running the pipeline…' : 'Regenerate from sources'}
        </Button>
      </div>

      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {warnings.map((warning, i) => (
            <li
              key={i}
              className="flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--warn)]/40
                         bg-[var(--warn)]/10 px-3 py-2 text-[12px] text-[var(--warn)]"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="step-label text-[var(--text-mute)]">Sources</h3>
        <ul className="flex flex-col gap-1.5">
          {PROFILE_SOURCES.map((source) => {
            const running = runningSource === source;
            return (
              <li
                key={source}
                className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border
                           border-[var(--line)] bg-[var(--bg-elev-2)] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-[var(--text)]">
                    {source.replace(/_/g, ' ')}
                  </p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-mute)]">
                    {SOURCE_HELP[source]}
                  </p>
                </div>

                {source === 'local_scan' ? (
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <Label htmlFor="scan-paths" className="sr-only-live">
                      Folder paths
                    </Label>
                    <Input
                      id="scan-paths"
                      value={paths}
                      onChange={(e) => setPaths(e.target.value)}
                      placeholder={'C:\\dev\\project, C:\\dev\\other'}
                      className="h-8 w-full text-[12px] sm:w-[18rem]"
                    />
                  </div>
                ) : null}

                <Button
                  variant="secondary"
                  size="sm"
                  disabled={running}
                  onClick={() =>
                    onIngest(
                      source,
                      source === 'local_scan' && paths.trim()
                        ? {
                            paths: paths
                              .split(',')
                              .map((p) => p.trim())
                              .filter(Boolean),
                          }
                        : undefined,
                    )
                  }
                >
                  {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {running ? 'Reading…' : 'Run ingest'}
                </Button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="step-label text-[var(--text-mute)]">Ingestion history</h3>
        {ordered.length === 0 ? (
          <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--line)] px-3 py-4 text-[12px] text-[var(--text-mute)]">
            No ingestion has run yet. This profile was written by hand or by the seed script.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {ordered.map((run) => {
              const failed = run.error != null;
              const duration =
                run.finishedAt != null ? run.finishedAt - run.startedAt : null;
              return (
                <li
                  key={run.id}
                  className={[
                    'rounded-[var(--radius-card)] border px-3 py-2',
                    failed
                      ? 'border-[var(--danger)]/40 bg-[var(--danger)]/10'
                      : 'border-[var(--line)] bg-[var(--bg-elev-2)]',
                  ].join(' ')}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-[12.5px] font-medium text-[var(--text)]">
                      {run.source.replace(/_/g, ' ')}
                    </span>
                    <Badge tone={failed ? 'danger' : run.finishedAt == null ? 'warn' : 'ok'}>
                      {failed ? (
                        <>
                          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                          failed
                        </>
                      ) : run.finishedAt == null ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          running
                        </>
                      ) : (
                        <>
                          <Check className="h-3 w-3" aria-hidden="true" />
                          complete
                        </>
                      )}
                    </Badge>
                    <span className="tnum text-[11px] text-[var(--text-mute)]">
                      {formatDateTime(run.startedAt)}
                    </span>
                    <span className="tnum text-[11px] text-[var(--text-mute)]">
                      {run.itemCount} item{run.itemCount === 1 ? '' : 's'}
                    </span>
                    {duration != null ? (
                      <span className="tnum text-[11px] text-[var(--text-mute)]">
                        {formatDuration(duration)}
                      </span>
                    ) : null}
                  </div>

                  {failed ? (
                    <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-[var(--danger)]">
                      <CircleSlash className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                      <span>{run.error}</span>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
