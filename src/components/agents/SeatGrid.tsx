'use client';

import { CircleDot } from 'lucide-react';

import { Avatar } from '@/components/table/Avatar';
import { cn } from '@/lib/utils';
import type { AvatarStyle } from '@/shared/constants';
import type { AgentDTO } from '@/shared/types';

/**
 * The seat grid on `/agents`, sections 15.3 and 12.1.
 *
 * One tile per seat, in `orderIndex` order — which is also seat order around
 * the table, so the grid reads in the same sequence as the room. The weight
 * badge is on every tile because it is on every seat at the table (section
 * 16.3): weighted voting is the product, and hiding the weights behind a click
 * would hide the thing being edited.
 *
 * State is never carried by colour alone (section 16.12): a disabled seat has a
 * struck-through name and the word "disabled", and an unsaved tile carries a
 * "unsaved" badge rather than only a coloured border.
 */

export interface SeatGridProps {
  agents: AgentDTO[];
  normalised: Record<string, number>;
  selectedId: string | null;
  dirtyIds: ReadonlySet<string>;
  onSelect: (agentId: string) => void;
}

export function SeatGrid({ agents, normalised, selectedId, dirtyIds, onSelect }: SeatGridProps) {
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
      {agents.map((agent) => {
        const selected = agent.id === selectedId;
        const share = agent.enabled ? (normalised[agent.id] ?? 0) : 0;
        const accent = `var(${agent.accentToken})`;

        return (
          <li key={agent.id}>
            <button
              type="button"
              onClick={() => onSelect(agent.id)}
              aria-current={selected ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-3 rounded-[var(--radius-card)] border px-3 py-2.5 text-left transition-colors',
                selected
                  ? 'border-[var(--gold)] bg-[var(--bg-elev-2)]'
                  : 'border-[var(--line)] bg-[var(--bg-elev-2)] hover:border-[var(--line-strong)]',
              )}
            >
              <span className="relative shrink-0">
                <span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-[var(--radius-pill)]"
                  style={{
                    border: `2px solid ${agent.enabled ? accent : 'var(--line)'}`,
                    opacity: agent.enabled ? 0.6 : 1,
                    background: `color-mix(in srgb, ${accent} 12%, transparent)`,
                  }}
                />
                <Avatar
                  style={agent.avatarStyle as AvatarStyle}
                  svg={agent.avatarSvg}
                  iconName={agent.iconName}
                  name={agent.name}
                  accent={accent}
                  size={34}
                  dimmed={!agent.enabled}
                />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'truncate text-[13px]',
                      agent.enabled ? 'text-[var(--text)]' : 'text-[var(--text-mute)] line-through',
                    )}
                  >
                    {agent.name}
                  </span>
                  {agent.isMeAgent ? (
                    <span className="step-label shrink-0 rounded-[var(--radius-pill)] border border-[var(--seat-1)]/40 px-1.5 py-[1px] text-[var(--seat-1)]">
                      you
                    </span>
                  ) : null}
                </span>

                <span className="mt-0.5 flex items-center gap-2">
                  <span className="tnum text-[11px] text-[var(--text-mute)]">
                    {agent.provider}, {agent.modelId}
                  </span>
                </span>
              </span>

              <span className="flex shrink-0 flex-col items-end gap-1">
                <span
                  className="tnum rounded-[var(--radius-pill)] border border-[var(--line)] bg-[var(--bg-elev-3)]
                             px-1.5 py-[1px] text-[10px] font-semibold text-[var(--text-dim)]"
                  title={`Normalised weight ${(share * 100).toFixed(1)}%`}
                >
                  {agent.enabled ? `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%` : '0%'}
                </span>
                {dirtyIds.has(agent.id) ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-[var(--warn)]">
                    <CircleDot className="h-2.5 w-2.5" aria-hidden="true" />
                    unsaved
                  </span>
                ) : !agent.enabled ? (
                  <span className="text-[10px] text-[var(--text-mute)]">disabled</span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
