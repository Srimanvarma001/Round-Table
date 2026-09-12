'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Controls } from '@/components/run/Controls';
import { ReasoningDrawer } from '@/components/run/ReasoningDrawer';
import { RevealCard } from '@/components/run/RevealCard';
import { StepTimeline } from '@/components/run/StepTimeline';
import { RoundTable } from '@/components/table/RoundTable';
import { Badge } from '@/components/ui/badge';
import { useAgents } from '@/hooks/useAgents';
import { useRunStream } from '@/hooks/useRunStream';
import { useSettings } from '@/hooks/useSettings';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatUsd } from '@/lib/utils';
import type { DissentRow, RevealPayload, RunMetrics } from '@/shared/events';
import type { ProposalScoreDTO } from '@/shared/types';

/**
 * The live table. Dense single-viewport control room: this root never grows
 * past its parent and never scrolls the page. Header and control bar take
 * their natural height; the table area fills the rest via flex-grow.
 */

export default function RunPage() {
  const { agents, normalisedWeights, isLoading } = useAgents();
  const { settings } = useSettings();
  const reducedMotion = useReducedMotion();

  const [seedPrompt, setSeedPrompt] = useState('');
  const [refineEnabled, setRefineEnabled] = useState(true);
  const [runId, setRunId] = useState<string | null>(null);
  const [drawerAgentId, setDrawerAgentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{
    scores: ProposalScoreDTO[];
    dissent: DissentRow[];
    metrics: RunMetrics | null;
  }>({ scores: [], dissent: [], metrics: null });

  const agentOrder = useMemo(() => agents.map((a) => a.id), [agents]);

  // `prefers-reduced-motion` drops the stagger cadence to zero.
  const cadence = reducedMotion ? 0 : settings.staggerCadenceMs;

  const { state, seats, controls, activeSeats, flushAll } = useRunStream({
    runId,
    agentOrder,
    cadenceMs: cadence,
  });

  const seatName = useCallback(
    (agentId: string) => agents.find((a) => a.id === agentId)?.name ?? agentId,
    [agents],
  );

  // Fetch the derived scores and dissent once the run reaches a terminal state.
  // These are the server's numbers; nothing is recomputed here.
  useEffect(() => {
    if (!runId) return;
    if (state.status !== 'completed' && state.status !== 'failed' && state.status !== 'aborted') return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as {
          scores: ProposalScoreDTO[];
          dissent: DissentRow[];
          metrics: RunMetrics | null;
        };
        if (!cancelled) {
          setDetail({
            scores: data.scores ?? [],
            dissent: data.dissent ?? [],
            metrics: data.metrics ?? null,
          });
        }
      } catch {
        // Non-fatal: the reveal card simply renders without the breakdown.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, state.status]);

  const handleGenerate = useCallback(async () => {
    if (!seedPrompt.trim()) return;
    setBusy(true);
    setDetail({ scores: [], dissent: [], metrics: null });
    try {
      const created = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seedPrompt: seedPrompt.trim(), refineEnabled }),
      });
      if (!created.ok) throw new Error(`Failed to create run (${created.status})`);
      const { runId: id } = (await created.json()) as { runId: string };

      // Set the id first so the SSE hook is listening before the loop starts.
      // Events emitted before the stream opens are replayed from run_events.
      setRunId(id);

      const started = await fetch(`/api/runs/${id}/start`, { method: 'POST' });
      if (!started.ok) throw new Error(`Failed to start run (${started.status})`);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }, [seedPrompt, refineEnabled]);

  const act = useCallback(
    async (path: string) => {
      if (!runId) return;
      await fetch(`/api/runs/${runId}/${path}`, { method: 'POST' });
    },
    [runId],
  );

  const refiningSeatNames = useMemo(
    () => activeSeats.filter((id) => state.step === 'refine').map(seatName),
    [activeSeats, state.step, seatName],
  );

  const proposalCount = useMemo(
    () => Number(state.stepSummary?.proposals ?? state.partialScores.length ?? 0),
    [state.stepSummary, state.partialScores],
  );

  const winner: RevealPayload | null = state.reveal;
  const showReveal = Boolean(winner || state.status === 'failed' || state.status === 'aborted');

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      {/* Polite live region: a screen-reader user is not dependent on watching
          the table. */}
      <p aria-live="polite" className="sr-only-live">
        {`Step ${state.step}. ${winner ? `Winner: ${winner.title}` : ''}`}
      </p>

      {/* Control bar: prompt input plus step strip. Fixed natural height. */}
      <section
        aria-label="Run controls"
        className="flex shrink-0 flex-col gap-2 rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--bg-elev-1)] px-3 py-2"
      >
        <Controls
          controls={controls}
          seedPrompt={seedPrompt}
          refineEnabled={refineEnabled}
          onSeedChange={setSeedPrompt}
          onRefineChange={setRefineEnabled}
          onGenerate={() => void handleGenerate()}
          onPause={() => void act('pause')}
          onResume={() => void act('resume')}
          onAbort={() => void act('abort')}
          onSkipAnimation={flushAll}
          busy={busy}
          buffered={activeSeats.length > 0}
        />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--line)] pt-1.5">
          <StepTimeline step={state.step} completedSteps={state.completedSteps} />

          <div className="tnum ml-auto flex items-center gap-2 text-[11px] text-[var(--text-mute)]">
            {state.round > 1 ? <span>Round {state.round}</span> : null}
            {state.failedSeats.length > 0 ? <span>{state.failedSeats.length} failed</span> : null}
            {winner ? <Badge tone="accent">Winner, {winner.title}</Badge> : null}
          </div>
        </div>
      </section>

      {/* Inline status strip: single line, never pushes the table off screen. */}
      {state.budgetWarning ? (
        <p
          role="status"
          className="shrink-0 truncate rounded-[var(--radius-card)] border border-[var(--warn)]/40
                     bg-[var(--warn)]/10 px-2.5 py-1 text-[11.5px] text-[var(--warn)]"
        >
          Budget warning, {formatUsd(state.budgetWarning.usedUsd)} of{' '}
          {formatUsd(state.budgetWarning.limitUsd)} used (
          {Math.round(state.budgetWarning.pct * 100)}%). Completed work is kept if the run
          aborts.
        </p>
      ) : null}

      {state.error && state.status === 'failed' ? (
        <p
          role="alert"
          className="shrink-0 truncate rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger)]/10
                     px-2.5 py-1 text-[11.5px] text-[var(--danger)]"
        >
          Run failed ({state.error.code}): {state.error.message}
        </p>
      ) : null}

      {state.status === 'paused' ? (
        <p
          role="status"
          className="shrink-0 truncate rounded-[var(--radius-card)] border border-[var(--line-strong)] bg-[var(--bg-elev-2)]
                     px-2.5 py-1 text-[11.5px] text-[var(--text-dim)]"
        >
          Paused. {state.pendingTaskKeys.length} pending. Resume continues without redoing
          completed work.
        </p>
      ) : null}

      {/* Table area: fills every remaining pixel. The table is the dominant
          element on screen; seats sit on its edge, not floating apart. */}
      <section
        aria-label="Round table"
        className="backroom-vignette relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--bg-elev-1)]"
      >
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[13px] text-[var(--text-mute)]">Loading the table…</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <RoundTable
              agents={agents}
              normalisedWeights={normalisedWeights}
              seats={seats}
              activeSeats={activeSeats}
              step={state.step}
              proposalCount={proposalCount}
              refiningSeatNames={refiningSeatNames}
              partialScores={state.partialScores}
              reveal={winner}
              reducedMotion={reducedMotion}
              drawerAgentId={drawerAgentId}
              onOpenDrawer={setDrawerAgentId}
            />
          </div>
        )}

        {/* Reveal overlays the table corner instead of pushing the page longer,
            so the single-viewport constraint holds on completed runs too. */}
        {showReveal ? (
          <div className="absolute bottom-2 right-2 top-2 z-40 flex w-[min(340px,38%)] min-h-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--gold)]/30 bg-[var(--bg-elev-1)]/96 shadow-[var(--elev-3)] backdrop-blur">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <RevealCard
                reveal={winner}
                metrics={state.metrics ?? detail.metrics}
                scores={detail.scores}
                dissent={detail.dissent}
                failedSeats={state.failedSeats.map((f) => ({ seatName: seatName(f.agentId) }))}
                compact
              />
            </div>
          </div>
        ) : null}
      </section>

      <ReasoningDrawer
        agents={agents}
        seats={seats}
        openAgentId={drawerAgentId}
        onClose={() => setDrawerAgentId(null)}
        onClosed={(agentId) => {
          // Focus returns to the seat that opened the drawer.
          const el = document.querySelector<HTMLButtonElement>(
            `[aria-label^="${CSS.escape(seatName(agentId))}"]`,
          );
          el?.focus();
        }}
      />
    </div>
  );
}
