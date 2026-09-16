'use client';

import { AnimatePresence, motion } from 'framer-motion';

import type { PartialScore, RevealPayload } from '@/shared/events';
import type { StepName } from '@/shared/constants';
import { truncate } from '@/lib/utils';

/**
 * Wireframe table centre: quiet single-line status in small muted type.
 * No cards, no gold display type competing with the linework — just the step
 * name, the proposal count, revising names, a minimal ranking list, or the
 * winner title.
 */

export interface CenterPlinthProps {
  step: StepName;
  proposalCount: number;
  refiningSeatNames: string[];
  partialScores: PartialScore[];
  reveal: RevealPayload | null;
}

export function CenterPlinth({
  step,
  proposalCount,
  refiningSeatNames,
  partialScores,
  reveal,
}: CenterPlinthProps) {
  return (
    <div
      className="pointer-events-none absolute left-1/2 top-1/2 z-10 w-[min(30%,300px)] -translate-x-1/2 -translate-y-1/2"
      aria-live="polite"
    >
      <AnimatePresence mode="wait">
        {step === 'propose' && (
          <motion.p
            key="propose"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-center text-[12px] italic text-[var(--text-mute)]"
          >
            Proposing
          </motion.p>
        )}

        {step === 'debate' && (
          <motion.p
            key="debate"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="tnum text-center text-[12px] text-[var(--text-mute)]"
          >
            {proposalCount} <span className="italic">ideas on the table</span>
          </motion.p>
        )}

        {step === 'refine' && (
          <motion.div
            key="refine"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center gap-0.5"
          >
            <p className="text-[12px] italic text-[var(--text-mute)]">Revising</p>
            {refiningSeatNames.length === 0 ? (
              <p className="text-[11px] text-[var(--text-mute)]">No revisions</p>
            ) : (
              refiningSeatNames.map((name) => (
                <span key={name} className="text-[11px] text-[var(--text-dim)]">
                  {name}
                </span>
              ))
            )}
          </motion.div>
        )}

        {step === 'vote' && (
          <motion.div
            key="vote"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-auto flex flex-col"
          >
            <p className="mb-1 text-center text-[11px] italic text-[var(--text-mute)]">
              Live ranking
            </p>
            <AnimatePresence initial={false}>
              {partialScores.map((row) => (
                <motion.div
                  key={row.proposalId}
                  layout
                  transition={{ type: 'spring', stiffness: 260, damping: 30 }}
                  className="flex items-baseline justify-between gap-2 border-t border-[var(--line)] py-1 first:border-t-0"
                >
                  <span className="truncate text-[11px] text-[var(--text-dim)]">
                    {truncate(row.title, 40)}
                  </span>
                  <span className="tnum shrink-0 text-[11px] text-[var(--text-mute)]">
                    {row.weightedScore.toFixed(2)}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
            {partialScores.length === 0 && (
              <p className="text-center text-[11px] text-[var(--text-mute)]">
                Collecting votes…
              </p>
            )}
          </motion.div>
        )}

        {step === 'reveal' && (
          <motion.div
            key="reveal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-center"
          >
            <p className="mb-0.5 text-[11px] italic text-[var(--text-mute)]">Winner</p>
            <p className="text-[13px] leading-snug text-[var(--text-dim)]">
              {reveal?.title ?? 'Deciding…'}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
