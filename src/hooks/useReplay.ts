'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { useStaggerQueue } from '@/hooks/useStaggerQueue';
import type { ControlState, SeatLiveState } from '@/hooks/useRunStream';
import type { RunStatus, SeatState, StepName } from '@/shared/constants';
import { STEP_NAMES } from '@/shared/constants';
import type {
  PartialScore,
  RunEvent,
  RunEventType,
  RunMetrics,
  RevealPayload,
  StepSummary,
} from '@/shared/events';
import type { AgentDTO, RunDetailResponse, RunEventDTO } from '@/shared/types';

/**
 * Replay, section 18.2.
 *
 * "`/runs/[id]` reconstructs the entire table from stored rows. It reads
 *  `run_events` ordered by `seq` and re-emits them into the same reducer the
 *  live view uses, on a timer. **MUST** make zero LLM calls. Includes a
 *  scrubber over step boundaries so the user can jump straight to the vote or
 *  the reveal."
 *
 * This hook is the timer half of that. It opens no `EventSource` (that is
 * `useRunStream`'s job, and a replay has nothing to stream), reads one stored
 * snapshot, and plays its `events` array back through the identical reducer and
 * the identical stagger queue, so the table animates exactly as it did live.
 *
 * The reducer below is a deliberate mirror of the one in `useRunStream`. The
 * live reducer is private to that module and the card rule is that it is not
 * modified, so the two must be kept in step by hand; the event union in
 * `@/shared/events` is the contract between them and any new event type must be
 * handled in both.
 *
 * The client still never computes weighted scores here: `partial_scores` come
 * out of the stored payloads exactly as the server wrote them (section 15.2).
 */

// --- Reducer, mirrored from useRunStream ------------------------------------

export interface ReplayState {
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
  revision: number;
}

type ReplayAction =
  | { type: 'reset'; agentIds: string[] }
  | { type: 'event'; event: RunEvent };

const INITIAL_STEP: StepName = 'propose';

const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.aborted',
]);

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

function initReplayState(agentIds: string[]): ReplayState {
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

function patchSeat(state: ReplayState, agentId: string, patch: Partial<SeatLiveState>): ReplayState {
  const prev = state.seats[agentId] ?? blankSeat(agentId);
  return { ...state, seats: { ...state.seats, [agentId]: { ...prev, ...patch } } };
}

function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  if (action.type === 'reset') return initReplayState(action.agentIds);

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
        partialScores: (payload.partialScores as PartialScore[] | undefined) ?? state.partialScores,
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

// --- Scrubber marks ---------------------------------------------------------

export interface ReplayMark {
  step: StepName;
  /** Index into the event array; seeking to a mark applies events `0..index`. */
  index: number;
  /** Event index of the last event that belongs to this step. */
  endIndex: number;
  label: string;
  count: number;
}

/** Ordered playback speeds, per the section 18.2 "playback controls". */
export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/**
 * Recorded gaps are clamped: a run that sat paused for nine minutes between two
 * steps would otherwise make the replay unwatchable, and the point of the
 * scrubber is that the user can skip rather than wait.
 */
const MIN_GAP_MS = 8;
const MAX_GAP_MS = 220;

export interface UseReplayOptions {
  runId: string;
  cadenceMs?: number;
}

export interface UseReplayResult {
  /** Same shape the live view consumes, minus the transport concerns. */
  state: ReplayState;
  seats: Record<string, SeatLiveState>;
  controls: ControlState;
  activeSeats: string[];
  events: RunEvent[];
  flushAll: () => void;

  /** The stored snapshot the table is reconstructed from. */
  detail: RunDetailResponse | null;
  agents: AgentDTO[];
  normalisedWeights: Record<string, number>;
  loading: boolean;
  loadError: string | null;

  marks: ReplayMark[];
  activeMark: number;
  cursor: number;
  totalEvents: number;
  progress: number;

  playing: boolean;
  speed: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  restart: () => void;
  setSpeed: (speed: number) => void;
  seekToEvent: (index: number) => void;
  seekToMark: (markIndex: number) => void;
}

export function useReplay({ runId, cadenceMs = 45 }: UseReplayOptions): UseReplayResult {
  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);

  const [state, dispatch] = useReducer(replayReducer, [], initReplayState);

  // The seat order drives the stagger rotation and must match the snapshot the
  // run actually used, not the current `/agents` configuration (section 18.2:
  // the table is reconstructed from stored rows).
  const agentOrder = useMemo(() => {
    const snapshot = detail?.run.agentSnapshot ?? [];
    if (snapshot.length > 0) {
      return snapshot.slice().sort((a, b) => a.orderIndex - b.orderIndex).map((s) => s.id);
    }
    return (detail?.agents ?? []).map((a) => a.id);
  }, [detail]);

  const stagger = useStaggerQueue({ order: agentOrder, cadenceMs });
  const staggerRef = useRef(stagger);
  staggerRef.current = stagger;
  const orderRef = useRef(agentOrder);
  orderRef.current = agentOrder;

  // --- Load the stored run once, with its event log ------------------------
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}?events=1`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Failed to load run (${res.status})`);
        const data = (await res.json()) as RunDetailResponse;
        if (cancelled) return;

        const log: RunEvent[] = (data.events ?? [])
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map(toRunEvent);

        setDetail(data);
        setEvents(log);
        dispatch({
          type: 'reset',
          agentIds: snapshotOrder(data).map((s) => s.id),
        });
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load run');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Reset the stagger queue whenever the run identity changes.
  useEffect(() => {
    stagger.reset();
    setCursor(0);
    setPlaying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Replay is the demo mode: it opens already in motion rather than requiring a
  // press before anything happens.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    if (events.length === 0) return;
    autoStarted.current = true;
    setPlaying(true);
  }, [events.length]);

  const emit = useCallback((event: RunEvent) => {
    dispatch({ type: 'event', event });
    if (event.type === 'agent.delta' && event.agentId) {
      const p = event.payload as { kind: string; text: string };
      if (p.kind === 'text') staggerRef.current.push(event.agentId, p.text);
    } else if (event.type === 'agent.done' && event.agentId) {
      staggerRef.current.markDone(event.agentId);
    } else if (event.type === 'step.completed') {
      staggerRef.current.flushAll();
    } else if (TERMINAL_EVENTS.has(event.type)) {
      staggerRef.current.flushAll();
    }
  }, []);

  // --- The timer -----------------------------------------------------------
  useEffect(() => {
    if (!playing) return;
    if (cursor >= events.length) {
      setPlaying(false);
      return;
    }

    const current = events[cursor];
    const previous = cursor > 0 ? events[cursor - 1] : null;
    const recorded = previous ? current.createdAt - previous.createdAt : 0;
    const gap = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, recorded));
    const delay = Math.max(1, gap / speed);

    const handle = window.setTimeout(() => {
      emit(current);
      setCursor((c) => c + 1);
    }, delay);

    return () => window.clearTimeout(handle);
  }, [playing, cursor, events, speed, emit]);

  // --- Seeking -------------------------------------------------------------
  /**
   * Rebuild the table from zero up to `index`, then leave it there. Because a
   * seek is always to a step boundary or a user-scrubbed index, the entire
   * prefix is applied in one pass and the stagger queue is force-flushed: the
   * user asked to be *at* the vote, not to watch forty seconds of typing.
   */
  const seekToEvent = useCallback(
    (index: number) => {
      const target = Math.min(Math.max(0, index), events.length);
      dispatch({ type: 'reset', agentIds: orderRef.current });
      staggerRef.current.reset();

      const accumulated: Record<string, string> = {};
      const finished = new Set<string>();

      for (let i = 0; i < target; i += 1) {
        const event = events[i];
        if (!event) continue;
        dispatch({ type: 'event', event });
        if (event.type === 'agent.delta' && event.agentId) {
          const p = event.payload as { kind: string; text: string };
          if (p.kind === 'text') {
            accumulated[event.agentId] = (accumulated[event.agentId] ?? '') + p.text;
          }
        } else if (event.type === 'agent.done' && event.agentId) {
          finished.add(event.agentId);
        }
      }

      for (const [agentId, text] of Object.entries(accumulated)) {
        if (text) staggerRef.current.push(agentId, text);
        if (finished.has(agentId)) staggerRef.current.markDone(agentId);
      }
      staggerRef.current.flushAll();

      setCursor(target);
    },
    [events],
  );

  const restart = useCallback(() => {
    seekToEvent(0);
    setPlaying(true);
  }, [seekToEvent]);

  const play = useCallback(() => {
    // Pressing play at the end restarts rather than doing nothing.
    if (cursor >= events.length) {
      seekToEvent(0);
    }
    setPlaying(true);
  }, [cursor, events.length, seekToEvent]);

  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => {
    setPlaying((p) => !p);
  }, []);

  // --- Derived --------------------------------------------------------------
  const marks = useMemo(() => buildMarks(events), [events]);

  const activeMark = useMemo(() => {
    let found = 0;
    for (let i = 0; i < marks.length; i += 1) {
      if (cursor > marks[i].index) found = i;
    }
    return found;
  }, [marks, cursor]);

  const seats = useMemo(() => {
    const out: Record<string, SeatLiveState> = {};
    for (const [id, seat] of Object.entries(state.seats)) {
      const buffered = stagger.buffers[id];
      out[id] = { ...seat, visibleText: buffered?.visible ?? seat.rawText };
    }
    return out;
  }, [state.seats, stagger.buffers]);

  const controls: ControlState = useMemo(() => {
    if (state.status === 'completed' || state.status === 'aborted') return 'done';
    if (state.status === 'failed') return 'error';
    if (playing) return 'running';
    if (state.status === 'paused') return 'paused';
    return cursor > 0 ? 'paused' : 'idle';
  }, [state.status, playing, cursor]);

  const agents = useMemo(() => {
    const current = detail?.agents ?? [];
    const snapshot = detail?.run.agentSnapshot ?? [];
    const meAgentId = snapshot.find((s) => s.isMeAgent)?.id ?? null;
    // The stored snapshot fixes the ORDER and the membership; the live agent
    // rows supply the avatars, which the snapshot does not carry.
    if (snapshot.length === 0) {
      return current.slice().sort((a, b) => a.orderIndex - b.orderIndex);
    }
    const byId = new Map(current.map((a) => [a.id, a]));
    const ordered = snapshot
      .slice()
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((s) => byId.get(s.id))
      .filter((a): a is AgentDTO => a != null);
    // A deleted seat still shows if the snapshot alone can describe it.
    if (ordered.length === snapshot.length) return ordered;
    return current.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  }, [detail]);

  const normalisedWeights = useMemo(() => {
    const out: Record<string, number> = {};
    for (const entry of detail?.run.agentSnapshot ?? []) {
      out[entry.id] = entry.normalisedWeight;
    }
    return out;
  }, [detail]);

  return {
    state,
    seats,
    controls,
    activeSeats: stagger.activeSeats,
    events,
    flushAll: stagger.flushAll,

    detail,
    agents,
    normalisedWeights,
    loading,
    loadError,

    marks,
    activeMark,
    cursor,
    totalEvents: events.length,
    progress: events.length === 0 ? 0 : cursor / events.length,

    playing,
    speed,
    play,
    pause,
    toggle,
    restart,
    setSpeed,
    seekToEvent,
    seekToMark: (markIndex: number) => {
      const mark = marks[Math.min(Math.max(0, markIndex), marks.length - 1)];
      if (mark) seekToEvent(mark.index);
    },
  };
}

// --- Helpers ----------------------------------------------------------------

function toRunEvent(dto: RunEventDTO): RunEvent {
  return {
    id: dto.id,
    seq: dto.seq,
    runId: '',
    type: dto.type as RunEventType,
    agentId: dto.agentId ?? undefined,
    step: (dto.step as StepName | null) ?? undefined,
    payload: dto.payload,
    createdAt: dto.createdAt,
  };
}

function snapshotOrder(data: RunDetailResponse): Array<{ id: string; orderIndex: number }> {
  const snapshot = data.run.agentSnapshot ?? [];
  if (snapshot.length > 0) {
    return snapshot.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  }
  return (data.agents ?? [])
    .map((a) => ({ id: a.id, orderIndex: a.orderIndex }))
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

/**
 * One mark per step boundary, plus the two ends. A run whose refine step was
 * skipped simply has no mark for it, which is honest: the scrubber shows what
 * actually happened.
 */
function buildMarks(events: RunEvent[]): ReplayMark[] {
  const marks: ReplayMark[] = [{ step: 'propose', index: 0, endIndex: -1, label: 'Start', count: 0 }];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.type !== 'step.started') continue;
    const step = (event.payload as { step?: StepName }).step;
    if (!step || !STEP_NAMES.includes(step)) continue;
    if (marks.some((m) => m.step === step && m.label !== 'Start')) continue;
    marks.push({ step, index: i, endIndex: events.length - 1, label: humaniseStep(step), count: 0 });
  }

  // Each mark runs until the next one starts; the last runs to the end.
  for (let i = 0; i < marks.length; i += 1) {
    const next = marks[i + 1];
    marks[i].endIndex = next ? next.index - 1 : events.length - 1;
    marks[i].count = Math.max(0, marks[i].endIndex - marks[i].index + 1);
  }

  return marks;
}

function humaniseStep(step: StepName): string {
  return step.charAt(0).toUpperCase() + step.slice(1);
}
