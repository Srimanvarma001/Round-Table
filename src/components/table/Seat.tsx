'use client';

import { AnimatePresence, motion } from 'framer-motion';

import { SpeechBubble } from '@/components/table/SpeechBubble';
import { ThoughtCloud } from '@/components/table/ThoughtCloud';
import type { RectSeatPlacement } from '@/lib/layout/seats';
import type { SeatLiveState } from '@/hooks/useRunStream';
import type { SeatState } from '@/shared/constants';
import { truncate } from '@/lib/utils';
import type { AgentDTO } from '@/shared/types';

/**
 * Wireframe seat: a quiet outlined rectangular slot around the table.
 *
 * Resting state is monochrome linework only — thin border, transparent fill,
 * no avatar. The active seat picks up a faint warm-gold border tint. Thinking
 * renders the hand-drawn sketch bubble; spoken renders a one-line summary in
 * the same outlined style. Clicking opens the reasoning drawer.
 *
 * Five states, driven by the run reducer, never by local component state:
 *   idle | thinking | spoken | failed | disabled
 */

export interface SeatProps {
  agent: AgentDTO;
  /** Normalised weight, 0 to 1, from the server. */
  normalisedWeight: number;
  live: SeatLiveState | undefined;
  /** True while the stagger queue has this seat active. */
  staggering: boolean;
  /** Phase offset in seconds for the aura wave (kept for API compat). */
  auraDelay: number;
  x: number;
  y: number;
  /** Kept for API compat; the wireframe uses a fixed slot size. */
  diameter: number;
  reducedMotion: boolean;
  /** Below 1280px the bubble narrows and clamps to one line. */
  compactBubble: boolean;
  drawerOpenForSeat: boolean;
  registerRef: (agentId: string, el: HTMLButtonElement | null) => void;
  onOpen: (agentId: string) => void;
  layoutIdPrefix: string;
  /** Wireframe side, drives bubble-tail placement away from neighbours. */
  placement?: RectSeatPlacement | null;
}

const SLOT_W = 116;
const SLOT_H = 62;

export function Seat({
  agent,
  normalisedWeight,
  live,
  staggering,
  auraDelay,
  x,
  y,
  diameter,
  reducedMotion,
  compactBubble,
  drawerOpenForSeat,
  registerRef,
  onOpen,
  layoutIdPrefix,
  placement,
}: SeatProps) {
  void auraDelay;
  void diameter;
  void reducedMotion;
  void drawerOpenForSeat;
  void layoutIdPrefix;

  const state: SeatState = !agent.enabled
    ? 'disabled'
    : (live?.status ?? 'idle');

  // A seat whose buffer is still draining reads as thinking even after the
  // server finished; a finished and drained seat reads as spoken.
  const effectiveState: SeatState =
    state === 'idle' && staggering ? 'thinking' : state === 'spoken' && staggering ? 'thinking' : state;

  const accent = `var(${agent.accentToken})`;
  const isThinking = effectiveState === 'thinking';
  const isFailed = effectiveState === 'failed';
  const isSpoken = effectiveState === 'spoken';
  const isDisabled = effectiveState === 'disabled';
  const isActive = isThinking || isSpoken;
  const isYou = agent.isMeAgent;

  const bubbleSide = placement?.bubbleSide ?? (y > 62 ? 'above' : 'below');

  const take = live?.finalText || live?.visibleText || '';

  const borderColor = isFailed
    ? 'var(--danger)'
    : isDisabled
      ? 'var(--line)'
      : isThinking
        ? 'rgba(201,151,63,0.65)'
        : isYou
          ? 'rgba(201,151,63,0.45)'
          : isSpoken
            ? 'var(--text-mute)'
            : 'var(--line-strong)';

  return (
    <div
      className="absolute"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: SLOT_W + 72,
        transform: 'translate(-50%, -50%)',
        zIndex: isYou ? 25 : isThinking || isSpoken ? 20 : 10,
      }}
    >
      <button
        ref={(el) => registerRef(agent.id, el)}
        type="button"
        onClick={() => onOpen(agent.id)}
        disabled={isDisabled}
        aria-label={seatAriaLabel(agent, effectiveState, normalisedWeight, take)}
        className="wire-seat group relative mx-auto flex w-fit flex-col items-center gap-1.5 bg-transparent"
        style={{ cursor: isDisabled ? 'not-allowed' : 'pointer' }}
      >
        {/* The slot: simple outlined rectangle, transparent fill. You gets a
            slightly thicker border; active gets the faint gold tint. */}
        <span
          aria-hidden="true"
          className="block transition-colors"
          style={{
            width: SLOT_W,
            height: SLOT_H,
            border: `${isYou ? 1.5 : 1}px solid ${borderColor}`,
            borderRadius: 3,
            background: 'transparent',
            opacity: isDisabled ? 0.45 : 1,
            boxShadow: isThinking
              ? '0 0 0 1px rgba(201,151,63,0.15), 0 0 18px rgba(201,151,63,0.10)'
              : 'none',
          }}
        />

        {/* Quiet label under the slot: name + vote weight, small type only. */}
        <span className="flex max-w-[9rem] flex-col items-center gap-0 leading-tight">
          <span
            className={[
              'max-w-full truncate text-center text-[11px]',
              isDisabled
                ? 'text-[var(--text-mute)] line-through'
                : isActive || isYou
                  ? 'text-[var(--text-dim)]'
                  : 'text-[var(--text-mute)]',
            ].join(' ')}
          >
            {agent.name}
            {isYou && agent.name.trim().toLowerCase() !== 'you' ? (
              <span className="ml-1 text-[10px] italic text-[var(--gold-hi)]/80">you</span>
            ) : null}
          </span>
          <span
            className="tnum text-[10px] text-[var(--text-mute)]"
            title={`Voting weight ${(normalisedWeight * 100).toFixed(1)} percent`}
          >
            {isDisabled ? '0%' : `${(normalisedWeight * 100).toFixed(normalisedWeight < 0.1 ? 1 : 0)}%`}
          </span>
          {isFailed ? (
            <span className="max-w-full truncate text-[10px] text-[var(--danger)]">
              {live?.error?.code ?? 'FAILED'}
            </span>
          ) : null}
        </span>

        {/* Thinking: hand-drawn sketch bubble. Spoken: one-line summary in
            the same minimal outlined style. */}
        <AnimatePresence>
          {isThinking ? (
            <ThoughtCloud
              key="thinking"
              accent={accent}
              bubbleSide={bubbleSide}
              onClick={() => onOpen(agent.id)}
            />
          ) : null}
        </AnimatePresence>

        {isSpoken && take ? (
          <SpeechBubble
            take={truncate(take, 90)}
            accent={accent}
            compact={compactBubble}
            bubbleSide={bubbleSide}
            onOpen={() => onOpen(agent.id)}
          />
        ) : null}

        {/* Subtle active pulse on the slot outline only (transform/opacity). */}
        {isThinking && !reducedMotion ? (
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-0"
            style={{
              width: SLOT_W,
              height: SLOT_H,
              x: '-50%',
              border: '1px solid rgba(201,151,63,0.35)',
              borderRadius: 3,
            }}
            animate={{ opacity: [0.3, 0.9, 0.3] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
          />
        ) : null}
      </button>
    </div>
  );
}

/**
 * The accessible name of a seat carries the full state and the final score
 * value, so a screen-reader user is not dependent on watching the table.
 */
function seatAriaLabel(
  agent: AgentDTO,
  state: SeatState,
  weight: number,
  take: string,
): string {
  const parts = [
    agent.name,
    agent.isMeAgent ? 'your seat' : 'lens seat',
    `state ${state}`,
    `weight ${(weight * 100).toFixed(1)} percent`,
  ];
  if (take) parts.push(`said: ${truncate(take, 90)}`);
  parts.push('activate to open reasoning');
  return parts.join(', ');
}
