'use client';

import { AnimatePresence, motion } from 'framer-motion';

import { Avatar } from '@/components/table/Avatar';
import { SpeechBubble } from '@/components/table/SpeechBubble';
import { ThoughtCloud } from '@/components/table/ThoughtCloud';
import type { RectSeatPlacement } from '@/lib/layout/seats';
import type { SeatLiveState } from '@/hooks/useRunStream';
import type { AvatarStyle, SeatState } from '@/shared/constants';
import { seatCharacterImage } from '@/lib/avatars/characters';
import { truncate } from '@/lib/utils';
import type { AgentDTO } from '@/shared/types';

/**
 * Seat at the table: the character stands freely — no box — with its name and
 * vote weight under it. Thinking reads as a warm glow breathing behind the
 * character plus the hand-drawn sketch bubble; spoken renders a one-line
 * summary; disabled dims the character and strikes the name. Clicking opens
 * the reasoning drawer.
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

/** Horizontal spacer for the seat block; the character sizes itself. */
const SLOT_W = 116;
/** Character sprite size at the table (`pixel` style). */
const SEAT_SPRITE_PX = 68;
/** Medallion size at the table for the non-pixel styles. */
const SEAT_MEDALLION_PX = 48;

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
        {/* The seat: the character stands freely, no box. The sprite renders
            for the `pixel` style (every seeded seat's default); any other
            style renders the medallion the rest of the app uses, so the table
            never disagrees with the drawer. Disabled dims the whole seat. */}
        <span
          aria-hidden="true"
          className="relative block"
          style={{
            width: SLOT_W,
            height: SEAT_SPRITE_PX,
            opacity: isDisabled ? 0.45 : 1,
          }}
        >
          {/* Thinking: a warm glow breathing behind the character (opacity
              only, never under reduced motion). Rendered before the sprite so
              it paints behind it without z-index juggling. */}
          {isThinking && !reducedMotion ? (
            <motion.span
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2"
              style={{
                width: SLOT_W + 16,
                height: SEAT_SPRITE_PX + 28,
                x: '-50%',
                y: '-50%',
                borderRadius: '50%',
                background:
                  'radial-gradient(circle, rgba(201,151,63,0.30) 0%, rgba(201,151,63,0.12) 45%, transparent 72%)',
              }}
              animate={{ opacity: [0.3, 0.9, 0.3] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
            />
          ) : null}

          {(agent.avatarStyle as AvatarStyle) === 'pixel' ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={seatCharacterImage(agent.avatarSeed, agent.seatKey)}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                inset: 0,
                margin: 'auto',
                width: SEAT_SPRITE_PX,
                height: SEAT_SPRITE_PX,
                objectFit: 'contain',
                imageRendering: 'auto',
                filter: isThinking
                  ? 'drop-shadow(0 0 12px rgba(201,151,63,0.45)) drop-shadow(0 1px 2px rgba(0,0,0,0.45))'
                  : 'drop-shadow(0 1px 2px rgba(0,0,0,0.45))',
              }}
            />
          ) : (
            <span
              style={{
                position: 'absolute',
                inset: 0,
                margin: 'auto',
                width: SEAT_MEDALLION_PX,
                height: SEAT_MEDALLION_PX,
              }}
            >
              <Avatar
                style={agent.avatarStyle as AvatarStyle}
                svg={agent.avatarSvg}
                iconName={agent.iconName}
                name={agent.name}
                accent={accent}
                size={SEAT_MEDALLION_PX}
                seed={agent.avatarSeed}
                seatKey={agent.seatKey}
              />
            </span>
          )}
        </span>

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
