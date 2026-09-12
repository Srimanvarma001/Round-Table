/**
 * Staggered reveal pacing, section 16.10.
 *
 * Agents run in parallel on the server; the table reveals in sequence to stay
 * watchable. This is purely a client concern, but the pacing rules are pure
 * arithmetic over strings, so they live here rather than inside a React effect.
 * That is what makes section 19.1's `staggerQueue` cases testable without a
 * browser, and it keeps `useStaggerQueue` down to plumbing.
 *
 * The spec's rules, in its numbering:
 *  1. Every `agent.delta` goes into a per-seat buffer. Nothing renders
 *     immediately.
 *  2. A single queue drains buffers on a fixed cadence, advancing through seats
 *     in `order_index` order. A seat becomes `thinking` when its turn arrives,
 *     even if its server-side call already finished.
 *  3. If a seat's buffer exceeds a high-water mark the queue releases that seat
 *     faster until the buffer drains. The visual delay must never become a
 *     correctness bug.
 *  4. On `agent.done` the seat's buffer flushes at the accelerated rate.
 *  5. `step.completed` force-flushes every remaining buffer.
 *  7. Cadence is configurable. Zero disables staggering entirely and renders
 *     deltas as they arrive.
 *  8. `flushAll` is the "skip animation" control.
 */

import { DEFAULT_STAGGER_CADENCE_MS, STAGGER_HIGH_WATER_CHARS } from '@/shared/constants';

/** Characters released per tick under normal cadence. */
export const RELEASE_CHARS = 3;

/** Characters released per tick once a buffer is over the high-water mark. */
export const FAST_RELEASE_CHARS = 120;

export interface RevealBuffer {
  /** Text released to the UI. */
  visible: string;
  /** Characters still held back. */
  queue: string;
  /** The server has finished this seat's task. */
  done: boolean;
  /** Set once the seat has had a release slot, so its aura starts on schedule. */
  activated: boolean;
}

export type RevealBuffers = Record<string, RevealBuffer>;

export interface AdvanceOptions {
  highWaterChars: number;
  releaseChars: number;
  fastReleaseChars: number;
}

export const DEFAULT_ADVANCE_OPTIONS: AdvanceOptions = {
  highWaterChars: STAGGER_HIGH_WATER_CHARS,
  releaseChars: RELEASE_CHARS,
  fastReleaseChars: FAST_RELEASE_CHARS,
};

export function emptyRevealBuffer(): RevealBuffer {
  return { visible: '', queue: '', done: false, activated: false };
}

/**
 * Rule 7. Cadence at or below zero is a pass-through, and so is an explicit
 * `disabled` for `prefers-reduced-motion`. Both must bypass buffering entirely:
 * a buffer with nothing draining it is not "no animation", it is missing text.
 */
export function isPassThrough(cadenceMs: number, disabled: boolean): boolean {
  return disabled || cadenceMs <= 0;
}

/** Rule 1, or the pass-through path when pacing is off. */
export function receiveDelta(
  buffers: RevealBuffers,
  agentId: string,
  text: string,
  passThrough: boolean,
): RevealBuffers {
  if (!text) return buffers;

  const current = buffers[agentId] ?? emptyRevealBuffer();

  return {
    ...buffers,
    [agentId]: passThrough
      ? { ...current, visible: current.visible + text, activated: true }
      : { ...current, queue: current.queue + text },
  };
}

/** Rule 4: mark the seat finished. The remainder drains at the fast rate. */
export function finishSeat(buffers: RevealBuffers, agentId: string): RevealBuffers {
  const current = buffers[agentId] ?? emptyRevealBuffer();
  return { ...buffers, [agentId]: { ...current, done: true, activated: true } };
}

/** Rules 5 and 8: release everything immediately. */
export function flushAllBuffers(buffers: RevealBuffers): RevealBuffers {
  const next: RevealBuffers = {};
  for (const [id, b] of Object.entries(buffers)) {
    next[id] = { ...b, visible: b.visible + b.queue, queue: '' };
  }
  return next;
}

/**
 * A seat is active while it has queued text, or has been activated but has not
 * yet finished. This is what drives the thinking indicator's lifetime.
 */
export function isActiveBuffer(id: string, buffers: RevealBuffers): boolean {
  const b = buffers[id];
  return Boolean(b && (b.queue.length > 0 || (b.activated && !b.done)));
}

export function activeSeatsFor(buffers: RevealBuffers, order: readonly string[]): string[] {
  return order.filter((id) => isActiveBuffer(id, buffers));
}

export interface AdvanceResult {
  buffers: RevealBuffers;
  /** Rotation position, advanced by one on every tick. */
  cursor: number;
  /** False when the tick released nothing, so the caller can skip a render. */
  changed: boolean;
}

/**
 * One cadence tick. Returns a new buffer map; untouched seats keep their
 * identity so a caller comparing references sees only the seats that moved.
 */
export function advance(
  buffers: RevealBuffers,
  order: readonly string[],
  cursor: number,
  options: AdvanceOptions = DEFAULT_ADVANCE_OPTIONS,
): AdvanceResult {
  const { highWaterChars, releaseChars, fastReleaseChars } = options;

  // Rule 2: the rotation is over the ACTIVE seats, in order_index order, and
  // the list is fixed before any mutation so a seat that empties during this
  // tick still gets its slot.
  const seats = order.filter((id) => isActiveBuffer(id, buffers));
  if (seats.length === 0) return { buffers, cursor, changed: false };

  let next = buffers;
  let changed = false;

  const release = (id: string, take: number): void => {
    const b = next[id];
    if (!b || b.queue.length === 0 || take <= 0) return;
    const slice = b.queue.slice(0, take);
    next = {
      ...next,
      [id]: { ...b, visible: b.visible + slice, queue: b.queue.slice(take), activated: true },
    };
    changed = true;
  };

  // Rule 3: over-high-water seats drain first and faster, so a long agent reply
  // can never be held back far enough to look like a hang.
  for (const id of seats) {
    const b = next[id];
    if (b && b.queue.length > highWaterChars) release(id, fastReleaseChars);
  }

  // Rule 2: one release slot per tick, rotating through the active seats.
  const id = seats[cursor % seats.length];
  const b = next[id];
  if (b) release(id, b.done ? fastReleaseChars : releaseChars);

  return { buffers: next, cursor: cursor + 1, changed };
}

export { DEFAULT_STAGGER_CADENCE_MS };
