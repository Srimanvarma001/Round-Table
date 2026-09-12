'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  advance,
  activeSeatsFor,
  DEFAULT_ADVANCE_OPTIONS,
  finishSeat,
  flushAllBuffers,
  isPassThrough,
  receiveDelta,
  type AdvanceOptions,
  type RevealBuffers,
} from '@/lib/stagger/reveal';
import { DEFAULT_STAGGER_CADENCE_MS, STAGGER_HIGH_WATER_CHARS } from '@/shared/constants';

/**
 * Staggered reveal, section 16.10. The pacing rules themselves live in
 * `lib/stagger/reveal.ts` as pure functions; this hook is the React binding —
 * a ref for the working copy, an interval for the cadence, and one state commit
 * per tick.
 *
 * Keeping the working copy in a ref rather than in state stops the interval
 * from being torn down and rebuilt on every delta, which at 40ms coalescing
 * would be constant.
 */

export interface StaggerSeatBuffer {
  /** Text released to the UI. */
  visible: string;
  /** Characters still held back. */
  pending: number;
  /** The server has finished this seat's task. */
  done: boolean;
}

export interface UseStaggerQueueOptions {
  /** Seat ids in `order_index` order. Drives the release rotation. */
  order: string[];
  cadenceMs?: number;
  highWaterChars?: number;
  /** Disable everything for `prefers-reduced-motion` or a settings override. */
  disabled?: boolean;
}

export interface UseStaggerQueueResult {
  buffers: Record<string, StaggerSeatBuffer>;
  /** Seats still holding text or still waiting on the server. */
  activeSeats: string[];
  push: (agentId: string, text: string) => void;
  markDone: (agentId: string) => void;
  flushAll: () => void;
  reset: () => void;
}

const EMPTY: StaggerSeatBuffer = { visible: '', pending: 0, done: false };

export function useStaggerQueue({
  order,
  cadenceMs = DEFAULT_STAGGER_CADENCE_MS,
  highWaterChars = STAGGER_HIGH_WATER_CHARS,
  disabled = false,
}: UseStaggerQueueOptions): UseStaggerQueueResult {
  const [buffers, setBuffers] = useState<Record<string, StaggerSeatBuffer>>({});
  const [activeSeats, setActiveSeats] = useState<string[]>([]);

  const working = useRef<RevealBuffers>({});
  const cursor = useRef(0);

  // Read through refs inside the callbacks so the interval is not rebuilt when
  // a caller passes a fresh array or a new options object literal.
  const orderRef = useRef(order);
  orderRef.current = order;

  // Rule 7: `prefers-reduced-motion` reaches the hook as cadence 0, so the
  // pass-through test has to consider the cadence and not only `disabled`.
  // Treating 0 as "buffer everything and never drain" would render no text.
  const passThrough = isPassThrough(cadenceMs, disabled);
  const optionsRef = useRef<AdvanceOptions>(DEFAULT_ADVANCE_OPTIONS);
  optionsRef.current = { ...DEFAULT_ADVANCE_OPTIONS, highWaterChars };

  const commit = useCallback((next: RevealBuffers) => {
    const publicBuffers: Record<string, StaggerSeatBuffer> = {};
    for (const [id, b] of Object.entries(next)) {
      publicBuffers[id] = { visible: b.visible, pending: b.queue.length, done: b.done };
    }
    setBuffers(publicBuffers);
    setActiveSeats(activeSeatsFor(next, orderRef.current));
  }, []);

  const push = useCallback(
    (agentId: string, text: string) => {
      const next = receiveDelta(working.current, agentId, text, passThrough);
      if (next === working.current) return;
      working.current = next;
      commit(next);
    },
    [passThrough, commit],
  );

  const markDone = useCallback(
    (agentId: string) => {
      const next = finishSeat(working.current, agentId);
      working.current = next;
      commit(next);
    },
    [commit],
  );

  const flushAll = useCallback(() => {
    const next = flushAllBuffers(working.current);
    working.current = next;
    cursor.current = 0;
    commit(next);
  }, [commit]);

  const reset = useCallback(() => {
    working.current = {};
    cursor.current = 0;
    setBuffers({});
    setActiveSeats([]);
  }, []);

  useEffect(() => {
    if (passThrough) return;

    const id = window.setInterval(() => {
      const result = advance(working.current, orderRef.current, cursor.current, optionsRef.current);
      cursor.current = result.cursor;
      if (!result.changed) return;
      working.current = result.buffers;
      commit(result.buffers);
    }, cadenceMs);

    return () => window.clearInterval(id);
  }, [cadenceMs, passThrough, commit]);

  const publicBuffers = useMemo(() => buffers, [buffers]);

  return {
    buffers: publicBuffers,
    activeSeats,
    push,
    markDone,
    flushAll,
    reset,
  };
}

export function emptyBuffer(): StaggerSeatBuffer {
  return EMPTY;
}
