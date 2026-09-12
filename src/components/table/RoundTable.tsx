'use client';

import { LayoutGroup } from 'framer-motion';
import { useCallback, useMemo, useRef } from 'react';

import { CenterPlinth } from '@/components/table/CenterPlinth';
import { Seat } from '@/components/table/Seat';
import { SeatStack } from '@/components/table/SeatStack';
import { TableSurface } from '@/components/table/TableSurface';
import type { SeatLiveState } from '@/hooks/useRunStream';
import { useLayoutTier } from '@/hooks/useLayoutTier';
import { placeSeats } from '@/lib/layout/seats';
import type { PartialScore, RevealPayload } from '@/shared/events';
import type { StepName } from '@/shared/constants';
import type { AgentDTO } from '@/shared/types';
import { TABLE_ASPECT } from '@/shared/constants';

/**
 * The round table, section 16.1 and section 15.3.
 *
 * Owns the ellipse layout via `placeSeats`, distributes run state to seats, and
 * owns the LayoutGroup that makes the shared-layout expand to the reasoning
 * drawer work.
 *
 * The layout MUST be unit-tested against these properties: seat count matches,
 * all coordinates lie inside 0 to 100, screen-space gap between adjacent seats
 * is uniform within 2 percent, and the Me Agent lands at the top. Arc-length
 * spacing is easy to get subtly wrong and hard to eyeball, so it gets a test
 * rather than a scroll-through.
 */

export interface RoundTableProps {
  agents: AgentDTO[];
  normalisedWeights: Record<string, number>;
  seats: Record<string, SeatLiveState>;
  activeSeats: string[];
  step: StepName;
  proposalCount: number;
  refiningSeatNames: string[];
  partialScores: PartialScore[];
  reveal: RevealPayload | null;
  reducedMotion: boolean;
  drawerAgentId: string | null;
  onOpenDrawer: (agentId: string) => void;
}

export function RoundTable({
  agents,
  normalisedWeights,
  seats,
  activeSeats,
  step,
  proposalCount,
  refiningSeatNames,
  partialScores,
  reveal,
  reducedMotion,
  drawerAgentId,
  onOpenDrawer,
}: RoundTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const metrics = useLayoutTier(containerRef, agents.length);

  const refs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const registerRef = useCallback((agentId: string, el: HTMLButtonElement | null) => {
    if (el) refs.current.set(agentId, el);
    else refs.current.delete(agentId);
  }, []);

  // Section 16.1: index 0 is the Me Agent, seated at the head of the table.
  // `agents` arrives already ordered by order_index, which the seed puts the Me
  // Agent first in.
  const placements = useMemo(
    () => placeSeats(agents.length, metrics.radiusX, metrics.radiusY),
    [agents.length, metrics.radiusX, metrics.radiusY],
  );

  const activeSet = useMemo(() => new Set(activeSeats), [activeSeats]);

  // Section 16.10 rule 6: when more than one seat is thinking the auras
  // phase-offset by 0.4s each, so eight glows pulse in a visible wave rather
  // than in unison. Unison reads as a loading screen; a wave reads as a room.
  const auraDelays = useMemo(() => {
    const out: Record<string, number> = {};
    activeSeats.forEach((id, i) => {
      out[id] = (i % 8) * 0.4;
    });
    return out;
  }, [activeSeats]);

  const compact = metrics.tier === 'compact' || metrics.arcGapTooSmall;

  if (compact) {
    return (
      <SeatStack
        agents={agents}
        normalisedWeights={normalisedWeights}
        seats={seats}
        activeSet={activeSet}
        reducedMotion={reducedMotion}
        onOpenDrawer={onOpenDrawer}
        registerRef={registerRef}
      />
    );
  }

  return (
    <LayoutGroup>
      <div
        ref={containerRef}
        className="relative mx-auto w-full"
        style={{ aspectRatio: String(TABLE_ASPECT), maxHeight: '78vh' }}
      >
        {metrics.showTableSurface ? <TableSurface step={step} /> : null}

        <CenterPlinth
          step={step}
          proposalCount={proposalCount}
          refiningSeatNames={refiningSeatNames}
          partialScores={partialScores}
          reveal={reveal}
        />

        {agents.map((agent, i) => {
          const placement = placements[i];
          if (!placement) return null;
          return (
            <Seat
              key={agent.id}
              agent={agent}
              normalisedWeight={normalisedWeights[agent.id] ?? 0}
              live={seats[agent.id]}
              staggering={activeSet.has(agent.id)}
              auraDelay={auraDelays[agent.id] ?? 0}
              x={placement.x}
              y={placement.y}
              diameter={metrics.seatDiameter}
              reducedMotion={reducedMotion}
              compactBubble={metrics.compactBubble}
              drawerOpenForSeat={drawerAgentId === agent.id}
              registerRef={registerRef}
              onOpen={onOpenDrawer}
              layoutIdPrefix="avatar-"
            />
          );
        })}
      </div>
    </LayoutGroup>
  );
}
