'use client';

import { useCallback, useMemo, useRef } from 'react';

import { CenterPlinth } from '@/components/table/CenterPlinth';
import { Seat } from '@/components/table/Seat';
import { SeatStack } from '@/components/table/SeatStack';
import { TableSurface } from '@/components/table/TableSurface';
import type { SeatLiveState } from '@/hooks/useRunStream';
import { useLayoutTier } from '@/hooks/useLayoutTier';
import { placeRectSeats } from '@/lib/layout/seats';
import type { PartialScore, RevealPayload } from '@/shared/events';
import type { StepName } from '@/shared/constants';
import type { AgentDTO } from '@/shared/types';

/**
 * Wireframe round table: a portrait outline rectangle with 8 outlined seat
 * slots — 1 top (You, head of table), 3 down the left, 3 down the right,
 * 1 bottom. Monochrome linework; the warm accent appears only on the active
 * seat's border and the thinking bubble.
 *
 * The ellipse helpers in `lib/layout/seats` are untouched (unit-tested); this
 * view uses the fixed `placeRectSeats` wireframe instead.
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

  // Fixed wireframe: index 0 is the Me Agent at top-centre.
  const placements = useMemo(() => placeRectSeats(agents.length), [agents.length]);

  const activeSet = useMemo(() => new Set(activeSeats), [activeSeats]);

  const compact = metrics.tier === 'compact' || metrics.arcGapTooSmall;

  if (compact) {
    return (
      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        <SeatStack
          agents={agents}
          normalisedWeights={normalisedWeights}
          seats={seats}
          activeSet={activeSet}
          reducedMotion={reducedMotion}
          onOpenDrawer={onOpenDrawer}
          registerRef={registerRef}
        />
      </div>
    );
  }

  // `min-h` floors the height where the parent provides none (e.g. the
  // replay page stacks the table without a fixed-height ancestor). On the
  // live page the flex-1 parent already fills the viewport, so this is a
  // no-op there. Without it the percentage seat positions collapse into a
  // strip and the fixed-size slots overlap.
  return (
    <div ref={containerRef} className="relative mx-auto h-full min-h-[560px] w-full flex-1">
      <TableSurface step={step} />

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
            auraDelay={0}
            x={placement.x}
            y={placement.y}
            diameter={metrics.seatDiameter}
            reducedMotion={reducedMotion}
            compactBubble={metrics.compactBubble}
            drawerOpenForSeat={drawerAgentId === agent.id}
            registerRef={registerRef}
            onOpen={onOpenDrawer}
            layoutIdPrefix="avatar-"
            placement={placement}
          />
        );
      })}
    </div>
  );
}
