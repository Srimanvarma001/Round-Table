'use client';

import { AnimatePresence, motion } from 'framer-motion';

import { Avatar } from '@/components/table/Avatar';
import type { SeatLiveState } from '@/hooks/useRunStream';
import type { AvatarStyle } from '@/shared/constants';
import { seatCharacterImage } from '@/lib/avatars/characters';
import { truncate } from '@/lib/utils';
import type { AgentDTO } from '@/shared/types';

/**
 * Compact fallback (below 640px, or whenever the seat arc gap falls below
 * `seatDiameter × 1.35`): the wireframe becomes a vertical stack of outlined
 * slot rows — same monochrome linework, no fills.
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
    <ul className="flex flex-col gap-2">
      {agents.map((agent) => {
        const live = seats[agent.id];
        const thinking = activeSet.has(agent.id) || live?.status === 'thinking';
        const failed = live?.status === 'failed';
        const disabled = !agent.enabled;
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
              className="flex w-full items-center gap-3 rounded-[3px] border bg-transparent px-3 py-2 text-left"
              style={{
                borderColor: thinking
                  ? 'rgba(127,179,146,0.55)'
                  : failed
                    ? 'var(--danger)'
                    : 'var(--line-strong)',
                opacity: disabled ? 0.5 : 1,
              }}
            >
              <span
                aria-hidden="true"
                className="relative block h-9 w-14 shrink-0"
              >
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
                      width: 34,
                      height: 34,
                      objectFit: 'contain',
                      imageRendering: 'auto',
                      filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))',
                    }}
                  />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <Avatar
                      style={agent.avatarStyle as AvatarStyle}
                      svg={agent.avatarSvg}
                      iconName={agent.iconName}
                      name={agent.name}
                      accent={`var(${agent.accentToken})`}
                      size={30}
                      seed={agent.avatarSeed}
                      seatKey={agent.seatKey}
                    />
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[12px] text-[var(--text-dim)]">
                    {agent.name}
                    {agent.isMeAgent && agent.name.trim().toLowerCase() !== 'you' ? (
                      <span className="ml-1 text-[10px] italic text-[var(--gold-hi)]/80">you</span>
                    ) : null}
                  </span>
                  <span className="tnum shrink-0 text-[10px] text-[var(--text-mute)]">
                    {disabled ? '0%' : `${(weight * 100).toFixed(weight < 0.1 ? 1 : 0)}%`}
                  </span>
                </span>
                {take ? (
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--text-mute)]">
                    {truncate(take, 90)}
                  </span>
                ) : thinking ? (
                  <span className="mt-0.5 block text-[11px] italic text-[var(--text-mute)]">
                    thinking...
                  </span>
                ) : null}
              </span>

              <AnimatePresence>
                {thinking && (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="shrink-0 text-[12px] italic text-[var(--text-mute)]"
                    aria-label="thinking"
                  >
                    {reducedMotion ? '···' : '...'}
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
