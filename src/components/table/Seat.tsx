'use client';

import { motion } from 'framer-motion';

import { Avatar } from '@/components/table/Avatar';
import { SeatAura } from '@/components/table/SeatAura';
import { SpeechBubble } from '@/components/table/SpeechBubble';
import { FailedIndicator, ThoughtCloud } from '@/components/table/ThoughtCloud';
import type { SeatLiveState } from '@/hooks/useRunStream';
import type { AvatarStyle, SeatState } from '@/shared/constants';
import type { AgentDTO } from '@/shared/types';
import { truncate } from '@/lib/utils';

/**
 * The seat, sections 16.3 and 16.4.
 *
 * Every seat renders the same five stacked layers, and this order is fixed:
 *
 *   SeatAura      (behind, animated glow, thinking only)
 *   SeatRing      (2px ring in accent, accent-tinted fill at 12% alpha)
 *   Avatar        (the SVG or icon, inset 3px)
 *   WeightBadge   (bottom-right, "25%" in tabular numerals)
 *   NameLabel     (below the ring, 13px, text-dim)
 *   SpeechBubble  (below the name, highest z)
 *
 * The weight badge is ALWAYS visible, not hidden behind a hover. The whole
 * point of the product is weighted voting; a user should be able to see the
 * 25 percent seat without asking.
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
  /** Phase offset in seconds for the aura wave (section 16.10 rule 6). */
  auraDelay: number;
  x: number;
  y: number;
  diameter: number;
  reducedMotion: boolean;
  /** Below 1280px the bubble narrows and clamps to one line. */
  compactBubble: boolean;
  drawerOpenForSeat: boolean;
  registerRef: (agentId: string, el: HTMLButtonElement | null) => void;
  onOpen: (agentId: string) => void;
  /** Section 16.6: the seat's avatar unmounts as the drawer's copy mounts. */
  layoutIdPrefix: string;
}

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
}: SeatProps) {
  const state: SeatState = !agent.enabled
    ? 'disabled'
    : (live?.status ?? 'idle');

  // A seat whose buffer is still draining reads as thinking even after the
  // server finished, which is exactly what the stagger is for (section 16.10
  // rule 2). A seat whose call already finished and drained reads as spoken.
  const effectiveState: SeatState =
    state === 'idle' && staggering ? 'thinking' : state === 'spoken' && staggering ? 'thinking' : state;

  const accent = `var(${agent.accentToken})`;
  const isThinking = effectiveState === 'thinking';
  const isFailed = effectiveState === 'failed';
  const isSpoken = effectiveState === 'spoken';
  const isDisabled = effectiveState === 'disabled';

  // Ring alpha per the state table in section 16.4.
  const ringAlpha = isThinking || isSpoken ? 1 : isDisabled ? 0.0 : 0.35;
  const ringColor = isFailed ? 'var(--danger)' : accent;

  const avatarScale = isThinking ? 1.06 : 1;
  const avatarSaturation = isDisabled
    ? 0.4
    : isFailed
      ? 0.3
      : isThinking
        ? 1.15
        : isSpoken
          ? 1
          : 0.55;

  const take = live?.finalText || live?.visibleText || '';
  const label = agent.name;

  return (
    <div
      className="absolute"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: diameter,
        // Centre the seat on its computed point.
        transform: 'translate(-50%, -50%)',
        zIndex: isThinking || isSpoken ? 20 : 10,
      }}
    >
      {/* Keyboard order follows order_index, which is the DOM order here.
          Enter opens the drawer, Escape closes it, focus returns to the seat
          that opened it (section 16.12). */}
      <button
        ref={(el) => registerRef(agent.id, el)}
        type="button"
        onClick={() => onOpen(agent.id)}
        disabled={isDisabled}
        aria-label={seatAriaLabel(agent, effectiveState, normalisedWeight, take)}
        className="group relative flex w-full flex-col items-center bg-transparent p-0"
        style={{ cursor: isDisabled ? 'not-allowed' : 'pointer' }}
      >
        <div className="relative" style={{ width: diameter, height: diameter }}>
          <SeatAura
            accent={accent}
            active={isThinking}
            delay={auraDelay}
            reduced={reducedMotion}
          />

          {/* SeatRing — 2px accent ring, accent-tinted fill at 12% alpha. */}
          <div
            className="absolute inset-0 rounded-[var(--radius-pill)] transition-[background-color,border-color] duration-300"
            style={{
              border: `2px solid ${ringColor}`,
              borderColor: isFailed
                ? 'var(--danger)'
                : isDisabled
                  ? 'var(--line)'
                  : `color-mix(in srgb, ${accent} ${ringAlpha * 100}%, transparent)`,
              background: isDisabled
                ? 'var(--bg-elev-2)'
                : `color-mix(in srgb, ${accent} 12%, transparent)`,
            }}
          />

          {/* Avatar, inset 3px, with the saturation and scale from the state
              table. Animating transform, never width/height (section 16.13). */}
          <motion.div
            className="absolute inset-[3px]"
            animate={{ scale: avatarScale }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
            style={{ filter: `saturate(${avatarSaturation})` }}
          >
            {/* Section 16.6: exactly ONE of the seat copy and the drawer copy
                is mounted at a time, or Framer cannot resolve the pair. */}
            {!drawerOpenForSeat ? (
              <motion.div
                layoutId={`${layoutIdPrefix}${agent.id}`}
                className="h-full w-full rounded-[var(--radius-pill)]"
              >
                <Avatar
                  style={agent.avatarStyle as AvatarStyle}
                  svg={agent.avatarSvg}
                  iconName={agent.iconName}
                  name={agent.name}
                  accent={accent}
                  size={diameter - 10}
                  dimmed={isDisabled}
                />
              </motion.div>
            ) : (
              <div className="h-full w-full rounded-[var(--radius-pill)]" />
            )}
          </motion.div>

          {/* WeightBadge — always visible, tabular numerals. Disabled seats
              show 0 percent. */}
          <span
            className="tnum absolute -bottom-1 -right-1 rounded-[var(--radius-pill)] border
                       border-[var(--line)] bg-[var(--bg-elev-3)] px-1.5 py-[1px]
                       text-[10px] font-semibold leading-tight text-[var(--text-dim)]"
            style={{ boxShadow: 'var(--elev-1)' }}
            title={`Voting weight ${(normalisedWeight * 100).toFixed(1)}%`}
          >
            {isDisabled ? '0%' : `${(normalisedWeight * 100).toFixed(normalisedWeight < 0.1 ? 1 : 0)}%`}
          </span>

          {isThinking && (
            <ThoughtCloud
              accent={accent}
              reduced={reducedMotion}
              onClick={() => onOpen(agent.id)}
              label={`Show ${agent.name}'s reasoning`}
            />
          )}
          {isFailed && (
            <FailedIndicator
              message={live?.error?.code ?? 'FAILED'}
              onClick={() => onOpen(agent.id)}
              label={`Show ${agent.name}'s error`}
            />
          )}
        </div>

        {/* NameLabel — below the ring, 13px, text-dim. Never encoded in colour
            alone: the disabled state strikes the name through (section 16.12). */}
        <span
          className={[
            'mt-1.5 max-w-[9.5rem] truncate text-center text-[13px] leading-tight',
            isDisabled
              ? 'text-[var(--text-mute)] line-through'
              : isThinking || isSpoken
                ? 'text-[var(--text)]'
                : 'text-[var(--text-dim)]',
          ].join(' ')}
        >
          {label}
          {agent.isMeAgent ? (
            <span className="ml-1 text-[10px] text-[var(--text-mute)]">you</span>
          ) : null}
        </span>

        {isSpoken && take ? (
          <SpeechBubble
            take={truncate(take, 140)}
            accent={accent}
            compact={compactBubble}
            onOpen={() => onOpen(agent.id)}
          />
        ) : null}
      </button>
    </div>
  );
}

/**
 * The accessible name of a seat carries the full state and the final score
 * value, so a screen-reader user is not dependent on watching the table
 * (section 16.12).
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
