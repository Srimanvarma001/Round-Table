'use client';

import { motion } from 'framer-motion';

import { Avatar } from '@/components/table/Avatar';
import { SeatAura } from '@/components/table/SeatAura';
import { SpeechBubble } from '@/components/table/SpeechBubble';
import type { SeatLiveState } from '@/hooks/useRunStream';
import type { AvatarStyle, SeatState } from '@/shared/constants';
import type { AgentDTO } from '@/shared/types';
import { truncate } from '@/lib/utils';

/**
 * The seat: one grouped poker-chip unit per agent.
 *
 * Disc, name and weight badge are visually bound in a single compact card so
 * they read as one object on the felt, never as three floating elements. The
 * disc itself is a wax-seal medallion: solid accent fill, embossed ring,
 * drop shadow.
 *
 * Thinking reads as a soft pulsing glow ring around the disc (SeatAura).
 * There is no floating typing cloud. Clicking the seat opens the reasoning
 * drawer, which is where the full text lives.
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
  /** Phase offset in seconds for the aura wave. */
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
  // server finished; a finished and drained seat reads as spoken.
  const effectiveState: SeatState =
    state === 'idle' && staggering ? 'thinking' : state === 'spoken' && staggering ? 'thinking' : state;

  const accent = `var(${agent.accentToken})`;
  const isThinking = effectiveState === 'thinking';
  const isFailed = effectiveState === 'failed';
  const isSpoken = effectiveState === 'spoken';
  const isDisabled = effectiveState === 'disabled';
  const isYou = agent.isMeAgent;

  // The head of the table sits slightly larger, with a gold embossed border
  // and a soft glow so it reads as the host seat at a glance.
  const discDiameter = isYou ? Math.round(diameter * 1.2) : diameter;

  const ringColor = isFailed ? 'var(--danger)' : isYou ? 'var(--gold)' : accent;
  const ringAlpha = isThinking || isSpoken || isYou ? 1 : isDisabled ? 0.0 : 0.4;

  const avatarScale = isThinking ? 1.05 : 1;
  const avatarSaturation = isDisabled
    ? 0.4
    : isFailed
      ? 0.3
      : isThinking
        ? 1.15
        : isSpoken
          ? 1
          : 0.7;

  const take = live?.finalText || live?.visibleText || '';
  const label = agent.name;

  return (
    <div
      className="absolute"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: discDiameter + 36,
        // Centre the seat card on its computed point.
        transform: 'translate(-50%, -50%)',
        zIndex: isYou ? 25 : isThinking || isSpoken ? 20 : 10,
      }}
    >
      {/* Keyboard order follows order_index, which is the DOM order here.
          Enter opens the drawer, Escape closes it, focus returns to the seat
          that opened it. */}
      <button
        ref={(el) => registerRef(agent.id, el)}
        type="button"
        onClick={() => onOpen(agent.id)}
        disabled={isDisabled}
        aria-label={seatAriaLabel(agent, effectiveState, normalisedWeight, take)}
        className={[
          'group relative mx-auto flex w-fit flex-col items-center gap-1 rounded-[var(--radius-card)] border px-2 pb-1.5 pt-2 backdrop-blur-sm transition-colors',
          isYou
            ? 'border-[var(--gold)]/60 bg-[var(--bg-elev-1)]/92'
            : 'border-[var(--line)] bg-[var(--bg-elev-1)]/82 hover:border-[var(--line-strong)]',
        ].join(' ')}
        style={{
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          boxShadow: isYou
            ? '0 0 0 1px rgba(201,151,63,0.25), 0 0 22px rgba(201,151,63,0.22), var(--elev-2)'
            : 'var(--elev-1)',
        }}
      >
        <div className="relative" style={{ width: discDiameter, height: discDiameter }}>
          <SeatAura
            accent={isYou ? 'var(--gold)' : accent}
            active={isThinking}
            delay={auraDelay}
            reduced={reducedMotion}
          />

          {/* Chip rim: embossed ring in the seat accent, gold for the host. */}
          <div
            className="chip-ring absolute inset-0 rounded-[var(--radius-pill)] transition-[border-color] duration-300"
            style={{
              border: `2px solid ${ringColor}`,
              borderColor: isFailed
                ? 'var(--danger)'
                : isDisabled
                  ? 'var(--line)'
                  : isYou
                    ? 'var(--gold)'
                    : `color-mix(in srgb, ${accent} ${Math.round(ringAlpha * 100)}%, transparent)`,
              background: isDisabled
                ? 'var(--bg-elev-2)'
                : `color-mix(in srgb, ${accent} 14%, transparent)`,
            }}
          />

          {/* Medallion, inset 3px. Animating transform only, never size. */}
          <motion.div
            className="absolute inset-[3px]"
            animate={{ scale: avatarScale }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
            style={{ filter: `saturate(${avatarSaturation})` }}
          >
            {!drawerOpenForSeat ? (
              <motion.div
                layoutId={`${layoutIdPrefix}${agent.id}`}
                className="chip-disc relative h-full w-full overflow-hidden rounded-[var(--radius-pill)]"
              >
                <Avatar
                  style={agent.avatarStyle as AvatarStyle}
                  svg={agent.avatarSvg}
                  iconName={agent.iconName}
                  name={agent.name}
                  accent={accent}
                  size={discDiameter - 6}
                  dimmed={isDisabled}
                />
              </motion.div>
            ) : (
              <div className="h-full w-full rounded-[var(--radius-pill)]" />
            )}
          </motion.div>
        </div>

        {/* Name plus denomination, bound to the disc above in the same card.
            Never encoded in colour alone: disabled strikes through. */}
        <span className="flex max-w-[8.5rem] flex-col items-center gap-0.5">
          <span
            className={[
              'display-face max-w-full truncate text-center text-[13px] leading-tight',
              isDisabled
                ? 'text-[var(--text-mute)] line-through'
                : isThinking || isSpoken || isYou
                  ? 'text-[var(--text)]'
                  : 'text-[var(--text-dim)]',
            ].join(' ')}
          >
            {label}
            {isYou ? (
              <span className="ml-1 text-[10px] italic text-[var(--gold-hi)]">you</span>
            ) : null}
          </span>
          <span
            className="chip-denom tnum rounded-[var(--radius-pill)] px-1.5 py-px text-[10px] font-semibold leading-tight"
            title={`Voting weight ${(normalisedWeight * 100).toFixed(1)} percent`}
          >
            {isDisabled ? '0%' : `${(normalisedWeight * 100).toFixed(normalisedWeight < 0.1 ? 1 : 0)}%`}
          </span>
          {isFailed ? (
            <span
              role="button"
              tabIndex={-1}
              onClick={() => onOpen(agent.id)}
              aria-label={`Show ${agent.name}'s error`}
              title={live?.error?.code ?? 'FAILED'}
              className="max-w-full truncate rounded-[var(--radius-pill)] border border-[var(--danger)]/50 px-1.5 py-px text-[10px] text-[var(--danger)]"
            >
              {live?.error?.code ?? 'FAILED'}
            </span>
          ) : null}
        </span>

        {isSpoken && take ? (
          <SpeechBubble
            take={truncate(take, 140)}
            accent={isYou ? 'var(--gold)' : accent}
            compact={compactBubble}
            above={y > 62}
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
