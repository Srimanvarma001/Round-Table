'use client';

import { AnimatePresence, motion } from 'framer-motion';

import { Avatar } from '@/components/table/Avatar';
import type { SeatLiveState } from '@/hooks/useRunStream';
import { truncate } from '@/lib/utils';
import type { AvatarStyle } from '@/shared/constants';
import type { AgentDTO } from '@/shared/types';

/**
 * Compact layout, section 16.11 (below 640px, and whenever the seat arc gap
 * falls below `seatDiameter × 1.35`).
 *
 * The ellipse is abandoned. Seats become a vertical stack of rows: an avatar, a
 * name, a weight badge, and an inline thought indicator.
 *
 * This is a real layout, not a degraded one: it is what the replay view uses
 * for a run read on a phone, and it MUST be designed rather than fall out of a
 * breakpoint accident.
 */
export function SeatStack({
  agents,
  normalisedWeights,
  seats,
  activeSet,
  reducedMotion,
  onOpenDrawer,
  registerRef,
}: {
  agents: AgentDTO[];
  normalisedWeights: Record<string, number>;
  seats: Record<string, SeatLiveState>;
  activeSet: Set<string>;
  reducedMotion: boolean;
  onOpenDrawer: (agentId: string) => void;
  registerRef: (agentId: string, el: HTMLButtonElement | null) => void;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {agents.map((agent) => {
        const live = seats[agent.id];
        const thinking = activeSet.has(agent.id) || live?.status === 'thinking';
        const failed = live?.status === 'failed';
        const disabled = !agent.enabled;
        const accent = `var(${agent.accentToken})`;
        const take = live?.finalText || live?.visibleText || '';
        const weight = normalisedWeights[agent.id] ?? 0;

        return (
          <li key={agent.id}>
            <button
              ref={(el) => registerRef(agent.id, el)}
              type="button"
              disabled={disabled}
              onClick={() => onOpenDrawer(agent.id)}
              aria-label={`${agent.name}, weight ${(weight * 100).toFixed(1)} percent${
                take ? `, said: ${truncate(take, 60)}` : ''
              }`}
              className="flex w-full items-center gap-3 rounded-[var(--radius-card)] border
                         border-[var(--line)] bg-[var(--bg-elev-2)] px-3 py-2 text-left"
            >
              <span className="relative shrink-0">
                <span
                  className="absolute inset-0 rounded-[var(--radius-pill)]"
                  style={{
                    border: `2px solid ${failed ? 'var(--danger)' : accent}`,
                    opacity: thinking || live?.status === 'spoken' ? 1 : 0.35,
                    background: `color-mix(in srgb, ${accent} 12%, transparent)`,
                  }}
                />
                <Avatar
                  style={agent.avatarStyle as AvatarStyle}
                  svg={agent.avatarSvg}
                  iconName={agent.iconName}
                  name={agent.name}
                  accent={accent}
                  size={36}
                  dimmed={disabled}
                />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span
                    className={[
                      'truncate text-[13px]',
                      disabled
                        ? 'text-[var(--text-mute)] line-through'
                        : thinking
                          ? 'text-[var(--text)]'
                          : 'text-[var(--text-dim)]',
                    ].join(' ')}
                  >
                    {agent.name}
                  </span>
                  <span className="tnum shrink-0 rounded-[var(--radius-pill)] border border-[var(--line)] px-1.5 text-[10px] text-[var(--text-mute)]">
                    {disabled ? '0%' : `${(weight * 100).toFixed(weight < 0.1 ? 1 : 0)}%`}
                  </span>
                </span>
                {take ? (
                  <span className="mt-0.5 block truncate text-[12px] text-[var(--text-mute)]">
                    {truncate(take, 90)}
                  </span>
                ) : null}
              </span>

              {/* Inline thought indicator. With reduced motion this is a static
                  ellipsis rather than a pulse (section 16.12). */}
              <AnimatePresence>
                {thinking && (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="shrink-0 text-[13px] text-[var(--text-dim)]"
                    aria-label="thinking"
                  >
                    {reducedMotion ? (
                      <span aria-hidden="true">···</span>
                    ) : (
                      <span className="flex items-center gap-[3px]" aria-hidden="true">
                        {[0, 1, 2].map((i) => (
                          <motion.span
                            key={i}
                            className="block h-1 w-1 rounded-[var(--radius-pill)]"
                            style={{ background: accent }}
                            animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }}
                            transition={{
                              duration: 1.15,
                              repeat: Infinity,
                              delay: i * 0.16,
                              ease: 'easeInOut',
                            }}
                          />
                        ))}
                      </span>
                    )}
                  </motion.span>
                )}
              </AnimatePresence>

              {failed ? (
                <span className="shrink-0 text-[11px] text-[var(--danger)]">
                  {live?.error?.code ?? 'FAILED'}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
