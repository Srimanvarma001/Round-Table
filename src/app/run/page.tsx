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
 * Wireframe live table: single viewport, no page scroll. The portrait table
 * fills the visual centre; a slim quiet rail (~260px) docked to the right
 * edge carries the prompt, Generate, the current-step dot rail, and the
 * Stop/Abort text links. No top control bar.
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
    <div className="flex h-full min-h-0 flex-row overflow-hidden">
      {/* Polite live region: a screen-reader user is not dependent on watching
          the table. */}
      <p aria-live="polite" className="sr-only-live">
        {`Step ${state.step}. ${winner ? `Winner: ${winner.title}` : ''}`}
      </p>

      {/* Table area: every remaining pixel left of the rail. */}
      <section
        aria-label="Round table"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
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

        {/* Inline status lines overlay the bottom-left so they never push the
            table or introduce page scroll. */}
        <div className="pointer-events-none absolute bottom-2 left-2 z-30 flex max-w-[60%] flex-col gap-1">
          {state.budgetWarning ? (
            <p
              role="status"
              className="truncate border-l border-[var(--warn)]/60 pl-2 text-[11px] text-[var(--warn)]"
            >
              Budget warning, {formatUsd(state.budgetWarning.usedUsd)} of{' '}
              {formatUsd(state.budgetWarning.limitUsd)} used (
              {Math.round(state.budgetWarning.pct * 100)}%).
            </p>
          ) : null}

          {state.error && state.status === 'failed' ? (
            <p role="alert" className="truncate border-l border-[var(--danger)]/60 pl-2 text-[11px] text-[var(--danger)]">
              Run failed ({state.error.code}): {state.error.message}
            </p>
          ) : null}

          {state.status === 'paused' ? (
            <p role="status" className="truncate border-l border-[var(--line-strong)] pl-2 text-[11px] text-[var(--text-dim)]">
              Paused. {state.pendingTaskKeys.length} pending.
            </p>
          ) : null}
        </div>

        {/* Reveal overlays the table's bottom-left instead of pushing layout. */}
        {showReveal ? (
          <div className="absolute bottom-2 left-2 top-auto z-40 flex max-h-[46%] w-[min(340px,52%)] min-h-0 flex-col overflow-hidden rounded-[3px] border border-[var(--line-strong)] bg-[var(--bg)]/95 backdrop-blur">
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

      {/* Slim right rail: prompt, generate, current-step dots, stop/abort.
          Narrow, quiet, generous whitespace between groups. */}
      <aside
        aria-label="Run controls"
        className="flex h-full w-[248px] shrink-0 flex-col gap-6 overflow-y-auto border-l
                   border-[var(--line)] px-4 py-5"
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

        <div className="border-t border-[var(--line)] pt-5">
          <p className="mb-3 text-[11px] text-[var(--text-mute)]">Step</p>
          <StepTimeline
            step={state.step}
            completedSteps={state.completedSteps}
            orientation="rail"
          />
        </div>

        <div className="tnum mt-auto flex items-center gap-2 border-t border-[var(--line)] pt-4 text-[11px] text-[var(--text-mute)]">
          {state.round > 1 ? <span>Round {state.round}</span> : <span>Round 1</span>}
          {state.failedSeats.length > 0 ? <span>{state.failedSeats.length} failed</span> : null}
          {winner ? <Badge tone="accent">Winner</Badge> : null}
        </div>
      </aside>

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
