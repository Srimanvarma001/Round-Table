'use client';

import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  Pause,
  Play,
  RotateCcw,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';

import { ReasoningDrawer } from '@/components/run/ReasoningDrawer';
import { RevealCard } from '@/components/run/RevealCard';
import { StepTimeline } from '@/components/run/StepTimeline';
import { RoundTable } from '@/components/table/RoundTable';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/card';
import { REPLAY_SPEEDS, useReplay } from '@/hooks/useReplay';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useSettings } from '@/hooks/useSettings';
import { formatDateTime, formatDuration, formatUsd, humanise, truncate } from '@/lib/utils';
import type { RunStatus } from '@/shared/constants';
import { useStaggerQueue } from '@/hooks/useStaggerQueue';

/**
 * Read-only replay, section 18.2.
 *
 * "`/runs/[id]` reconstructs the entire table from stored rows. It reads
 *  `run_events` ordered by `seq` and re-emits them into the same reducer the
 *  live view uses, on a timer. **MUST** make zero LLM calls. Includes a
 *  scrubber over step boundaries so the user can jump straight to the vote or
 *  the reveal."
 *
 * Nothing on this page opens a network write or touches a provider. It reads
 * one stored snapshot plus its event log, and plays it back. That is what makes
 * replay the demo mode: the product is presentable on demand without spending a
 * cent, and a run recorded months ago still animates exactly as it did.
 *
 * `useStaggerQueue` is imported directly only for its type; the queue itself is
 * owned by `useReplay`.
 */

const STATUS_TONE: Record<RunStatus, NonNullable<BadgeProps['tone']>> = {
  created: 'neutral',
  running: 'accent',
  paused: 'warn',
  completed: 'ok',
  failed: 'danger',
  aborted: 'warn',
};

export default function RunReplayPage() {
  const params = useParams<{ id: string }>();
  const runId = params?.id ?? '';

  const reducedMotion = useReducedMotion();
  const { settings } = useSettings();
  const cadence = reducedMotion ? 0 : settings.staggerCadenceMs;

  const replay = useReplay({ runId, cadenceMs: cadence });
  const {
    state,
    seats,
    controls,
    activeSeats,
    agents,
    normalisedWeights,
    detail,
    loading,
    loadError,
    marks,
    activeMark,
    cursor,
    totalEvents,
    playing,
    speed,
    toggle,
    restart,
    setSpeed,
    seekToEvent,
    seekToMark,
    flushAll,
  } = replay;

  const [drawerAgentId, setDrawerAgentId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const scrubTimer = useRef<number | null>(null);

  const buffered = activeSeats.length > 0;
  const shownCursor = scrubValue ?? cursor;

  const handleScrub = useCallback(
    (value: number) => {
      setScrubValue(value);
      if (scrubTimer.current != null) window.clearTimeout(scrubTimer.current);
      // Debounced so a drag rebuilds the table once, not sixty times a second.
      scrubTimer.current = window.setTimeout(() => {
        seekToEvent(value);
        setScrubValue(null);
      }, 90);
    },
    [seekToEvent],
  );

  const proposalCount = useMemo(
    () => Number(state.stepSummary?.proposals ?? 0),
    [state.stepSummary],
  );

  const seatName = useCallback(
    (agentId: string) => agents.find((a) => a.id === agentId)?.name ?? agentId,
    [agents],
  );

  const copyMarkdown = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs/${runId}/export?format=md`);
      if (!res.ok) return;
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [runId]);

  if (loading) {
    return (
      <Panel className="flex h-[50vh] items-center justify-center">
        <p className="text-[13px] text-[var(--text-mute)]">Reconstructing the table…</p>
      </Panel>
    );
  }

  if (loadError || !detail) {
    return (
      <div className="flex flex-col gap-4">
        <div
          role="alert"
          className="rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger)]/10
                     px-3 py-2 text-[12.5px] text-[var(--danger)]"
        >
          {loadError ?? 'That run could not be loaded.'}
        </div>
        <Button variant="secondary" size="md" asChild className="self-start">
          <Link href="/runs">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to history
          </Link>
        </Button>
      </div>
    );
  }

  const run = detail.run;
  const durationMs =
    run.startedAt != null && run.completedAt != null ? run.completedAt - run.startedAt : null;
  const noEvents = totalEvents === 0;

  return (
    <div className="flex flex-col gap-6">
      <p aria-live="polite" className="sr-only-live">
        {`Replay of run from ${formatDateTime(run.createdAt)}. Step ${state.step}. ${
          state.reveal ? `Winner: ${state.reveal.title}` : ''
        }`}
      </p>

      {/* --- Header ------------------------------------------------------- */}
      <Panel className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[run.status as RunStatus]}>
                {humanise(run.status)}
              </Badge>
              <Badge tone="neutral">replay — read only</Badge>
              <Badge tone="neutral">no model calls</Badge>
              <span className="tnum text-[11px] text-[var(--text-mute)]">
                {formatDateTime(run.createdAt)}
              </span>
            </div>
            <h1 className="display-face mt-2 text-[var(--fs-h1)] font-semibold leading-snug text-[var(--text)]">
              {run.seedPrompt}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" asChild>
              <Link href="/runs">
                <ArrowLeft className="h-3.5 w-3.5" />
                History
              </Link>
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void copyMarkdown()}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy Markdown'}
            </Button>
            <Button variant="secondary" size="sm" asChild>
              <a href={`/api/runs/${runId}/export?format=md`} download>
                <Download className="h-3.5 w-3.5" />
                .md
              </a>
            </Button>
            <Button variant="secondary" size="sm" asChild>
              <a href={`/api/runs/${runId}/export?format=json`} download>
                <Download className="h-3.5 w-3.5" />
                .json
              </a>
            </Button>
          </div>
        </div>

        <dl className="tnum flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-[var(--line)] pt-3 text-[11.5px] text-[var(--text-mute)]">
          <Meta label="Winner" value={detail.reveal?.title ?? run.errorCode ?? '—'} />
          <Meta
            label="Winning score"
            value={detail.metrics ? detail.metrics.winnerScore.toFixed(3) : '—'}
          />
          <Meta label="Duration" value={formatDuration(durationMs)} />
          <Meta label="Cost" value={formatUsd(run.costEstimateUsd)} />
          <Meta label="Calls" value={String(run.llmCalls)} />
          <Meta label="Tokens" value={`${run.tokensIn} in / ${run.tokensOut} out`} />
          <Meta label="Profile" value={run.profileId ?? 'none'} />
        </dl>

        {run.errorCode ? (
          <p
            role="status"
            className="rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger)]/10
                       px-3 py-2 text-[12.5px] text-[var(--danger)]"
          >
            This run ended with {run.errorCode}
            {run.errorMessage ? `: ${run.errorMessage}` : ''}. The stored steps still replay.
          </p>
        ) : null}
      </Panel>

      {/* --- Playback and scrubber ---------------------------------------- */}
      <Panel className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="md" onClick={toggle} disabled={noEvents}>
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {playing ? 'Pause' : cursor >= totalEvents && totalEvents > 0 ? 'Play again' : 'Play'}
          </Button>

          <Button variant="secondary" size="md" onClick={restart} disabled={noEvents}>
            <RotateCcw className="h-3.5 w-3.5" />
            Restart
          </Button>

          {buffered ? (
            <Button variant="ghost" size="md" onClick={flushAll} title="Flush buffered text">
              <Zap className="h-3.5 w-3.5" />
              Skip animation
            </Button>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            <span className="step-label text-[var(--text-mute)]">Speed</span>
            <div
              role="group"
              aria-label="Playback speed"
              className="flex items-center gap-0.5 rounded-[var(--radius-pill)] border border-[var(--line)] bg-[var(--bg-elev-1)] p-1"
            >
              {REPLAY_SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={speed === s}
                  onClick={() => setSpeed(s)}
                  className={[
                    'tnum rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px] transition-colors',
                    speed === s
                      ? 'bg-[var(--bg-elev-3)] text-[var(--text)]'
                      : 'text-[var(--text-dim)] hover:text-[var(--text)]',
                  ].join(' ')}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--line)] pt-3">
          <StepTimeline
            step={state.step}
            completedSteps={state.completedSteps}
            skippedSteps={skippedSteps(marks.map((m) => m.step))}
            onSeek={(step) => {
              const index = marks.findIndex((m) => m.step === step);
              if (index >= 0) seekToMark(index);
            }}
          />
        </div>

        {/* The scrubber: step boundaries first, because the section 18.2
            requirement is to jump straight to the vote or the reveal, then a
            fine-grained slider over the whole event log for anyone who wants
            the middle of the debate. */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {marks.map((mark, i) => (
              <button
                key={`${mark.step}-${mark.index}`}
                type="button"
                aria-current={activeMark === i ? 'true' : undefined}
                onClick={() => seekToMark(i)}
                className={[
                  'flex items-center gap-1.5 rounded-[var(--radius-pill)] border px-2.5 py-1',
                  'text-[11px] transition-colors',
                  activeMark === i
                    ? 'border-[var(--seat-5)] bg-[var(--seat-5)]/10 text-[var(--text)]'
                    : 'border-[var(--line)] text-[var(--text-dim)] hover:border-[var(--line-strong)]',
                ].join(' ')}
                title={`${mark.count} stored events`}
              >
                <span className="step-label">{mark.label}</span>
                <span className="tnum text-[10px] text-[var(--text-mute)]">{mark.count}</span>
              </button>
            ))}
          </div>

          <label className="flex items-center gap-3">
            <span className="step-label shrink-0 text-[var(--text-mute)]">Event</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, totalEvents)}
              value={shownCursor}
              onChange={(e) => handleScrub(Number(e.target.value))}
              disabled={noEvents}
              aria-label="Scrub through the stored event log"
              className="h-1.5 w-full cursor-pointer appearance-none rounded-[var(--radius-pill)]
                         bg-[var(--bg-elev-3)] accent-[var(--seat-5)]"
            />
            <span className="tnum w-[7.5rem] shrink-0 text-right text-[11px] text-[var(--text-mute)]">
              {shownCursor} / {totalEvents}
            </span>
          </label>

          {noEvents ? (
            <p className="text-[11.5px] text-[var(--warn)]">
              No stored events for this run. The finished artefacts below are still complete — the
              event log is what drives the animation, not the result.
            </p>
          ) : null}
        </div>
      </Panel>

      {/* --- The table ---------------------------------------------------- */}
      {agents.length === 0 ? (
        <Panel className="flex h-[40vh] items-center justify-center">
          <p className="text-[13px] text-[var(--text-mute)]">
            This run has no seat snapshot to reconstruct.
          </p>
        </Panel>
      ) : (
        <RoundTable
          agents={agents}
          normalisedWeights={normalisedWeights}
          seats={seats}
          activeSeats={activeSeats}
          step={state.step}
          proposalCount={proposalCount}
          refiningSeatNames={activeSeats.filter((id) => state.step === 'refine').map(seatName)}
          partialScores={state.partialScores}
          reveal={state.reveal}
          reducedMotion={reducedMotion}
          drawerAgentId={drawerAgentId}
          onOpenDrawer={setDrawerAgentId}
        />
      )}

      {state.reveal || controls === 'done' || state.status === 'failed' || state.status === 'aborted' ? (
        <RevealCard
          reveal={state.reveal}
          metrics={state.metrics ?? detail.metrics}
          scores={detail.scores}
          dissent={detail.dissent}
          failedSeats={state.failedSeats.map((f) => ({ seatName: seatName(f.agentId) }))}
        />
      ) : null}

      <ReasoningDrawer
        agents={agents}
        seats={seats}
        openAgentId={drawerAgentId}
        onClose={() => setDrawerAgentId(null)}
        onClosed={(agentId) => {
          const el = document.querySelector<HTMLButtonElement>(
            `[aria-label^="${CSS.escape(seatName(agentId))}"]`,
          );
          el?.focus();
        }}
      />
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-[var(--text-mute)]">{label}</dt>
      <dd className="max-w-[24ch] truncate text-[var(--text-dim)]" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * A step with no stored `step.started` event never ran — refine is skipped
 * automatically when no proposal drew a critique (section 11.3), and the
 * timeline should say "skipped" rather than leave it looking pending.
 */
function skippedSteps(present: string[]): Array<'refine'> {
  const out: Array<'refine'> = [];
  if (present.length > 0 && !present.includes('refine')) out.push('refine');
  return out;
}
