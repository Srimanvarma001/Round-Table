'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Controls } from '@/components/run/Controls';
import { ReasoningDrawer } from '@/components/run/ReasoningDrawer';
import { RevealCard } from '@/components/run/RevealCard';
import { StepTimeline } from '@/components/run/StepTimeline';
import { RoundTable } from '@/components/table/RoundTable';
import { Badge } from '@/components/ui/badge';
import { Panel } from '@/components/ui/card';
import { useAgents } from '@/hooks/useAgents';
import { useRunStream } from '@/hooks/useRunStream';
import { useSettings } from '@/hooks/useSettings';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatUsd } from '@/lib/utils';
import { STEP_NAMES } from '@/shared/constants';
import type { DissentRow, PartialScore, RevealPayload, RunMetrics } from '@/shared/events';
import type { ProposalScoreDTO } from '@/shared/types';

/**
 * The live table, section 15.1. Default landing page.
 *
 * One reducer for the live run, fed by the SSE hook (section 15.2). The client
 * NEVER computes weighted scores during a live run: it renders the
 * `partial_scores` the server includes in vote-step events.
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

  // Section 16.12: `prefers-reduced-motion` drops the stagger cadence to zero.
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

  const winner = state.reveal;

  return (
    <div className="flex flex-col gap-6">
      {/* Polite live region: a screen-reader user is not dependent on watching
          the table (section 16.12). */}
      <p aria-live="polite" className="sr-only-live">
        {`Step ${state.step}. ${winner ? `Winner: ${winner.title}` : ''}`}
      </p>

      <Panel className="flex flex-col gap-4 px-5 py-4">
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

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[var(--line)] pt-3">
          <StepTimeline step={state.step} completedSteps={state.completedSteps} />

          <div className="tnum ml-auto flex items-center gap-3 text-[11.5px] text-[var(--text-mute)]">
            <span>{state.round > 1 ? `round ${state.round}` : ''}</span>
            <span>{state.failedSeats.length > 0 ? `${state.failedSeats.length} failed` : ''}</span>
            {winner ? <Badge tone="ok">winner: {winner.title}</Badge> : null}
          </div>
        </div>
      </Panel>

      {state.budgetWarning ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--warn)]/40
                     bg-[var(--warn)]/10 px-3 py-2 text-[12.5px] text-[var(--warn)]"
        >
          Budget warning: {formatUsd(state.budgetWarning.usedUsd)} of{' '}
          {formatUsd(state.budgetWarning.limitUsd)} used (
          {Math.round(state.budgetWarning.pct * 100)}%). Completed artefacts are preserved if the
          run aborts.
        </div>
      ) : null}

      {state.error && state.status === 'failed' ? (
        <div
          role="alert"
          className="rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger)]/10
                     px-3 py-2 text-[12.5px] text-[var(--danger)]"
        >
          Run failed ({state.error.code}): {state.error.message}
        </div>
      ) : null}

      {state.status === 'paused' ? (
        <div
          role="status"
          className="rounded-[var(--radius-card)] border border-[var(--line-strong)] bg-[var(--bg-elev-2)]
                     px-3 py-2 text-[12.5px] text-[var(--text-dim)]"
        >
          Paused. {state.pendingTaskKeys.length} task
          {state.pendingTaskKeys.length === 1 ? '' : 's'} still pending. Resume continues from the
          next pending task — completed work is never re-requested.
        </div>
      ) : null}

      {isLoading ? (
        <Panel className="flex h-[60vh] items-center justify-center">
          <p className="text-[13px] text-[var(--text-mute)]">Loading the table…</p>
        </Panel>
      ) : (
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
      )}

      {winner || state.status === 'failed' || state.status === 'aborted' ? (
        <RevealCard
          reveal={winner}
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
          // Focus returns to the seat that opened the drawer (section 16.12).
          const el = document.querySelector<HTMLButtonElement>(
            `[aria-label^="${CSS.escape(seatName(agentId))}"]`,
          );
          el?.focus();
        }}
      />
    </div>
  );
}
