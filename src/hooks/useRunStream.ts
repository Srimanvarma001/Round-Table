'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import { useStaggerQueue } from '@/hooks/useStaggerQueue';
import type { RunStatus, SeatState, StepName } from '@/shared/constants';
import type { PartialScore, RunEvent, RunMetrics, RevealPayload, StepSummary } from '@/shared/events';
import { isTerminal } from '@/shared/constants';

/**
 * The live run client, sections 15.2 and 13.4.
 *
 * One reducer, fed by the SSE hook, owning: seats (status plus buffered and
 * displayed text), step, proposals, critiques, votes, partialScores, controls,
 * and reveal.
 *
 * MUST: the client never computes weighted scores. It renders the
 * `partial_scores` the server sends on vote-step `agent.done` events and
 * `step.completed`. One implementation of the math lives in
 * `lib/agents/weights.ts`, used by the server and the tests.
 */

export type ControlState = 'idle' | 'running' | 'paused' | 'done' | 'error';

export interface SeatLiveState {
  agentId: string;
  status: SeatState;
  /** Staggered, displayed text — comes from the stagger queue. */
  visibleText: string;
  /** Raw accumulated answer text — feeds the reasoning drawer. */
  rawText: string;
  /** Raw accumulated reasoning-channel text, section 16.6. */
  reasoningText: string;
  /** True when the model exposed no separate reasoning channel. */
  noReasoningChannel: boolean;
  finalText: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  error: { code: string; message: string } | null;
}

interface RunState {
  status: RunStatus;
  step: StepName;
  round: number;
  completedSteps: StepName[];
  seats: Record<string, SeatLiveState>;
  partialScores: PartialScore[];
  stepSummary: StepSummary | null;
  budgetWarning: { usedUsd: number; limitUsd: number; pct: number } | null;
  pendingTaskKeys: string[];
  reveal: RevealPayload | null;
  metrics: RunMetrics | null;
  failedSeats: Array<{ agentId: string; code: string; message: string }>;
  error: { code: string; message: string } | null;
  /** Bumped on every terminal or step boundary so effects can react. */
  revision: number;
}

type Action =
  | { type: 'reset'; agentIds: string[] }
  | { type: 'event'; event: RunEvent }
  | { type: 'seed'; seats: Record<string, SeatLiveState>; partialScores: PartialScore[]; reveal: RevealPayload | null; metrics: RunMetrics | null; status: RunStatus; step: StepName }
  | { type: 'transport-error'; message: string };

const INITIAL_STEP: StepName = 'propose';

function blankSeat(agentId: string): SeatLiveState {
  return {
    agentId,
    status: 'idle',
    visibleText: '',
    rawText: '',
    reasoningText: '',
    noReasoningChannel: false,
    finalText: '',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    latencyMs: 0,
    error: null,
  };
}

function initState(agentIds: string[]): RunState {
  const seats: Record<string, SeatLiveState> = {};
  for (const id of agentIds) seats[id] = blankSeat(id);
  return {
    status: 'created',
    step: INITIAL_STEP,
    round: 1,
    completedSteps: [],
    seats,
    partialScores: [],
    stepSummary: null,
    budgetWarning: null,
    pendingTaskKeys: [],
    reveal: null,
    metrics: null,
    failedSeats: [],
    error: null,
    revision: 0,
  };
}

function patchSeat(
  state: RunState,
  agentId: string,
  patch: Partial<SeatLiveState>,
): RunState {
  const prev = state.seats[agentId] ?? blankSeat(agentId);
  return { ...state, seats: { ...state.seats, [agentId]: { ...prev, ...patch } } };
}

function reducer(state: RunState, action: Action): RunState {
  switch (action.type) {
    case 'reset':
      return initState(action.agentIds);

    case 'seed':
      return {
        ...state,
        seats: { ...state.seats, ...action.seats },
        partialScores: action.partialScores,
        reveal: action.reveal,
        metrics: action.metrics,
        status: action.status,
        step: action.step,
        revision: state.revision + 1,
      };

    case 'transport-error':
      // Section 13.4: a close without a terminal event is a transport failure,
      // and the caller falls back to polling once before deciding to reconnect.
      return { ...state, error: { code: 'TRANSPORT', message: action.message } };

    case 'event': {
      const { event } = action;
      const agentId = event.agentId;
      const payload = event.payload as Record<string, unknown>;

      switch (event.type) {
        case 'run.started':
          return { ...state, status: 'running', error: null, revision: state.revision + 1 };

        case 'step.started':
          return {
            ...state,
            step: (payload.step as StepName) ?? state.step,
            round: (payload.round as number) ?? state.round,
            // A new step starts with a clean plinth; it fills as votes land.
            partialScores: event.step === 'vote' ? [] : state.partialScores,
            revision: state.revision + 1,
          };

        case 'agent.status': {
          if (!agentId) return state;
          return patchSeat(state, agentId, { status: (payload.status as SeatState) ?? 'idle' });
        }

        case 'agent.delta': {
          if (!agentId) return state;
          const kind = payload.kind as 'reasoning' | 'text';
          const text = String(payload.text ?? '');
          const seat = state.seats[agentId] ?? blankSeat(agentId);
          // The drawer streams the raw channels; the seat bubble uses the
          // staggered copy owned by useStaggerQueue. Section 16.6.
          if (kind === 'reasoning') {
            return patchSeat(state, agentId, { reasoningText: seat.reasoningText + text });
          }
          return patchSeat(state, agentId, { rawText: seat.rawText + text });
        }

        case 'agent.done': {
          if (!agentId) return state;
          const seat = state.seats[agentId] ?? blankSeat(agentId);
          return {
            ...patchSeat(state, agentId, {
              status: 'spoken',
              finalText: String(payload.finalText ?? ''),
              tokensIn: Number(payload.tokensIn ?? 0),
              tokensOut: Number(payload.tokensOut ?? 0),
              costUsd: Number(payload.costUsd ?? 0),
              latencyMs: Number(payload.latencyMs ?? 0),
              // If a seat produced no reasoning text at all, the drawer says so
              // in one line rather than showing an empty pane (section 16.6).
              noReasoningChannel: seat.reasoningText.length === 0,
            }),
            partialScores: (payload.partialScores as PartialScore[] | undefined) ?? state.partialScores,
          };
        }

        case 'agent.failed': {
          if (!agentId) return state;
          return {
            ...patchSeat(state, agentId, {
              status: 'failed',
              error: {
                code: String(payload.code ?? 'INTERNAL'),
                message: String(payload.message ?? 'Call failed'),
              },
            }),
            failedSeats: [
              ...state.failedSeats.filter((f) => f.agentId !== agentId),
              {
                agentId,
                code: String(payload.code ?? 'INTERNAL'),
                message: String(payload.message ?? 'Call failed'),
              },
            ],
          };
        }

        case 'step.completed': {
          const step = (payload.step as StepName) ?? state.step;
          return {
            ...state,
            stepSummary: (payload.summary as StepSummary) ?? null,
            partialScores:
              (payload.partialScores as PartialScore[] | undefined) ?? state.partialScores,
            completedSteps: state.completedSteps.includes(step)
              ? state.completedSteps
              : [...state.completedSteps, step],
            revision: state.revision + 1,
          };
        }

        case 'budget.warning':
          return {
            ...state,
            budgetWarning: {
              usedUsd: Number(payload.usedUsd ?? 0),
              limitUsd: Number(payload.limitUsd ?? 0),
              pct: Number(payload.pct ?? 0),
            },
          };

        case 'run.paused':
          return {
            ...state,
            status: 'paused',
            pendingTaskKeys: (payload.pendingTaskKeys as string[]) ?? [],
            revision: state.revision + 1,
          };

        case 'run.resumed':
          return {
            ...state,
            status: 'running',
            step: (payload.step as StepName) ?? state.step,
            revision: state.revision + 1,
          };

        case 'run.completed':
          return {
            ...state,
            status: 'completed',
            reveal: (payload.winner as RevealPayload) ?? null,
            metrics: (payload.metrics as RunMetrics) ?? null,
            revision: state.revision + 1,
          };

        case 'run.failed':
          return {
            ...state,
            status: 'failed',
            error: {
              code: String(payload.code ?? 'INTERNAL'),
              message: String(payload.message ?? 'Run failed'),
            },
            revision: state.revision + 1,
          };

        case 'run.aborted':
          return { ...state, status: 'aborted', revision: state.revision + 1 };

        default:
          return state;
      }
    }

    default:
      return state;
  }
}

export interface UseRunStreamOptions {
  runId: string | null;
  agentOrder: string[];
  cadenceMs?: number;
  /** Disable SSE and poll instead. */
  forcePolling?: boolean;
}

export interface UseRunStreamResult {
  state: RunState;
  seats: Record<string, SeatLiveState>;
  controls: ControlState;
  activeSeats: string[];
  events: RunEvent[];
  flushAll: () => void;
  connected: boolean;
  reconnect: () => void;
}

export function useRunStream({
  runId,
  agentOrder,
  cadenceMs,
  forcePolling = false,
}: UseRunStreamOptions): UseRunStreamResult {
  const [state, dispatch] = useReducer(reducer, agentOrder, initState);
  const stagger = useStaggerQueue({ order: agentOrder, cadenceMs });
  const eventsRef = useRef<RunEvent[]>([]);
  const [connected, setConnected] = useReducer((_: boolean, v: boolean) => v, false);
  const esRef = useRef<EventSource | null>(null);
  const staggerRef = useRef(stagger);
  staggerRef.current = stagger;
  // `agentOrder` is often a fresh array identity every render (e.g. mapped
  // from a query result upstream). Keep it in a ref so `resetRun` stays
  // stable and the reset effect below only fires when `runId` changes.
  // Otherwise: new array -> new callback -> effect re-runs -> setState ->
  // re-render -> new array -> infinite "Maximum update depth exceeded".
  const agentOrderRef = useRef(agentOrder);
  agentOrderRef.current = agentOrder;

  const resetRun = useCallback(() => {
    eventsRef.current = [];
    staggerRef.current.reset();
    dispatch({ type: 'reset', agentIds: agentOrderRef.current });
  }, []);

  // Reset whenever the run changes.
  useEffect(() => {
    resetRun();
  }, [runId, resetRun]);

  // --- SSE, section 13.4 ---------------------------------------------------
  useEffect(() => {
    if (!runId || forcePolling) return;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;

    const es = new EventSource(`/api/runs/${runId}/stream`);
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (msg) => {
      if (!msg.data) return;
      let event: RunEvent;
      try {
        event = JSON.parse(msg.data) as RunEvent;
      } catch {
        return;
      }

      eventsRef.current.push(event);
      dispatch({ type: 'event', event });

      // Drive the stagger queue from the same stream. Section 16.10.
      if (event.type === 'agent.delta' && event.agentId) {
        const p = event.payload as { kind: string; text: string };
        if (p.kind === 'text') staggerRef.current.push(event.agentId, p.text);
      } else if (event.type === 'agent.done' && event.agentId) {
        staggerRef.current.markDone(event.agentId);
      } else if (event.type === 'step.completed') {
        // Rule 5: force-flush so a fast step cannot leave a seat mid-sentence.
        staggerRef.current.flushAll();
      } else if (
        event.type === 'run.completed' ||
        event.type === 'run.failed' ||
        event.type === 'run.aborted'
      ) {
        staggerRef.current.flushAll();
        es.close();
        setConnected(false);
      }
    };

    es.onerror = () => {
      setConnected(false);
      // The browser reconnects on its own and sends Last-Event-ID, so the
      // server replays only what was missed. We do not tear the stream down
      // unless it was already closed.
      if (es.readyState === EventSource.CLOSED) {
        dispatch({
          type: 'transport-error',
          message: 'Stream closed before the run reached a terminal state.',
        });
      }
    };

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [runId, forcePolling]);

  // --- Polling fallback, section 15.2 --------------------------------------
  useEffect(() => {
    if (!runId) return;
    if (!forcePolling && connected) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as {
          run: { status: RunStatus; currentStep: StepName };
          agents: Array<{ id: string }>;
          partialScores?: PartialScore[];
          reveal?: RevealPayload | null;
          metrics?: RunMetrics | null;
        };
        if (cancelled) return;

        const seats: Record<string, SeatLiveState> = {};
        for (const a of data.agents ?? []) {
          seats[a.id] = { ...blankSeat(a.id), status: 'idle' };
        }
        dispatch({
          type: 'seed',
          seats,
          partialScores: data.partialScores ?? [],
          reveal: data.reveal ?? null,
          metrics: data.metrics ?? null,
          status: data.run.status,
          step: data.run.currentStep,
        });
        if (isTerminal(data.run.status)) window.clearInterval(handle);
      } catch {
        // A failed poll is not fatal; the next tick tries again.
      }
    };

    const handle = window.setInterval(tick, 2000);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [runId, forcePolling, connected]);

  // --- Merge the staggered text into seat state ----------------------------
  const seats = useMemo(() => {
    const out: Record<string, SeatLiveState> = {};
    for (const [id, seat] of Object.entries(state.seats)) {
      const buffered = stagger.buffers[id];
      out[id] = { ...seat, visibleText: buffered?.visible ?? '' };
    }
    return out;
  }, [state.seats, stagger.buffers]);

  const controls: ControlState = useMemo(() => {
    if (state.status === 'completed' || state.status === 'aborted') return 'done';
    if (state.status === 'failed') return 'error';
    if (state.status === 'paused') return 'paused';
    if (state.status === 'running') return 'running';
    return 'idle';
  }, [state.status]);

  const reconnect = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setConnected(false);
    // Recreate on the next render by nudging the effect: simplest reliable
    // path is a full reload of the run, which the caller does by resetting.
  }, []);

  return {
    state,
    seats,
    controls,
    activeSeats: stagger.activeSeats,
    events: eventsRef.current,
    flushAll: stagger.flushAll,
    connected,
    reconnect,
  };
}
