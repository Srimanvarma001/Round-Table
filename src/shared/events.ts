import type { ErrorCode, RunStatus, SeatState, StepName } from './constants';

/**
 * The SSE event union, section 13.3.
 * Every event carries `seq` (per-run monotonic) and the bus assigns the
 * autoincrement `id` that doubles as the SSE Last-Event-ID.
 */

export type RunEventType =
  | 'run.started'
  | 'step.started'
  | 'agent.status'
  | 'agent.delta'
  | 'agent.done'
  | 'agent.failed'
  | 'step.completed'
  | 'budget.warning'
  | 'run.paused'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed'
  | 'run.aborted';

export interface RunEvent {
  /** Autoincrement row id; the SSE `id:` field. */
  id: number;
  seq: number;
  runId: string;
  type: RunEventType;
  agentId?: string;
  step?: StepName;
  payload: unknown;
  createdAt: number;
}

/** Payload shapes, keyed by event type. */
export interface EventPayloads {
  'run.started': { steps: string[] };
  'step.started': { step: StepName; round: number };
  'agent.status': { status: SeatState };
  'agent.delta': { kind: 'reasoning' | 'text'; text: string };
  'agent.done': {
    finalText: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    latencyMs: number;
    /** Present on vote-step completions so the plinth updates incrementally. */
    partialScores?: PartialScore[];
  };
  'agent.failed': { code: ErrorCode | string; message: string; retryable: boolean };
  'step.completed': { step: StepName; summary: StepSummary; partialScores?: PartialScore[] };
  'budget.warning': { usedUsd: number; limitUsd: number; pct: number };
  'run.paused': { pendingTaskKeys: string[]; nextStep: StepName };
  'run.resumed': { step: StepName };
  'run.completed': { winner: RevealPayload | null; metrics: RunMetrics };
  'run.failed': { code: ErrorCode | string; message: string };
  'run.aborted': { atStep: StepName };
}

export interface PartialScore {
  proposalId: string;
  title: string;
  weightedScore: number;
  votesCast: number;
  leadAccent: string;
}

export interface StepSummary {
  proposals?: number;
  critiques?: number;
  refined?: number;
  votes?: number;
  failedSeats?: string[];
  warnings?: string[];
}

export interface RevealPayload {
  title: string;
  description: string;
  whyItWon: string;
  firstSteps: string[];
  risks: string[];
  proposalId: string | null;
  deterministicFallback?: boolean;
}

export interface RunMetrics {
  winnerScore: number;
  scoreSpread: number;
  meAlignment: boolean;
  dissentCount: number;
  distinctness: number;
  totalCostUsd: number;
  failedSeats: string[];
}

export interface DissentRow {
  agentId: string;
  seatName: string;
  accentToken: string;
  score: number;
  comment: string;
}

/** Narrow helper so payload consumers stay typed. */
export function payloadOf<T extends RunEventType>(
  event: RunEvent,
  _type: T,
): EventPayloads[T] {
  return event.payload as EventPayloads[T];
}

export interface RunSummary {
  id: string;
  seedPrompt: string;
  status: RunStatus;
  currentStep: string;
  winnerTitle: string | null;
  winnerScore: number | null;
  costEstimateUsd: number;
  createdAt: number;
  completedAt: number | null;
  durationMs: number | null;
}
