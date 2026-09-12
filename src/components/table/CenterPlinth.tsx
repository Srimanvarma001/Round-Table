'use client';

import { AnimatePresence, motion } from 'framer-motion';

import type { PartialScore, RevealPayload } from '@/shared/events';
import type { StepName } from '@/shared/constants';
import { truncate } from '@/lib/utils';

/**
 * The table centre. The focal point of the screen, carrying the run's live
 * state in muted gold sentence-case type — small and quiet, never a shouty
 * caps label.
 *
 *   propose | step name in muted gold
 *   debate  | the proposal count
 *   refine  | the names of the seats currently revising, stacked vertically
 *   vote    | the live ranking plinth
 *   reveal  | the winner's title, in the largest type on the page
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
      className="pointer-events-none absolute left-1/2 top-1/2 z-30 w-[min(44%,500px)] -translate-x-1/2 -translate-y-1/2"
      aria-live="polite"
    >
      <AnimatePresence mode="wait">
        {step === 'propose' && (
          <motion.p
            key="propose"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="display-face text-center text-[15px] italic text-[var(--gold-hi)]/70"
          >
            Proposing
          </motion.p>
        )}

        {step === 'debate' && (
          <motion.p
            key="debate"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="tnum text-center text-[var(--text-dim)]"
          >
            <span className="display-face text-[26px] font-semibold text-[var(--gold-hi)]">
              {proposalCount}
            </span>{' '}
            <span className="text-[var(--fs-small)]">ideas on the table</span>
          </motion.p>
        )}

        {step === 'refine' && (
          <motion.div
            key="refine"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center gap-1"
          >
            <p className="display-face text-[13px] italic text-[var(--gold-hi)]/70">Revising</p>
            {refiningSeatNames.length === 0 ? (
              <p className="text-[var(--fs-small)] text-[var(--text-mute)]">No revisions</p>
            ) : (
              refiningSeatNames.map((name, i) => (
                <motion.span
                  key={name}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.12 }}
                  className="display-face text-[13px] text-[var(--text-dim)]"
                >
                  {name}
                </motion.span>
              ))
            )}
          </motion.div>
        )}

        {step === 'vote' && (
          <motion.div
            key="vote"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="pointer-events-auto flex flex-col gap-1.5"
          >
            <p className="display-face mb-0.5 text-center text-[13px] italic text-[var(--gold-hi)]/70">
              Live ranking
            </p>
            {/* Rows reorder as votes land, so consensus visibly forms. Scores
                come from the server partial_scores payload; never computed. */}
            <AnimatePresence initial={false}>
              {partialScores.map((row) => (
                <motion.div
                  key={row.proposalId}
                  layout
                  transition={{ type: 'spring', stiffness: 260, damping: 30 }}
                  className="rounded-lg border border-[var(--line-strong)] bg-[var(--bg-elev-1)]/88 px-2.5 py-1 backdrop-blur-sm"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12px] text-[var(--text-dim)]">
                      {/* Truncated to 46 characters. */}
                      {truncate(row.title, 46)}
                    </span>
                    <span className="tnum shrink-0 text-[12px] font-semibold text-[var(--gold-hi)]">
                      {row.weightedScore.toFixed(2)}
                    </span>
                  </div>
                  <motion.div
                    layout
                    className="mt-1 h-1.5 rounded-[var(--radius-pill)]"
                    style={{
                      background: `linear-gradient(90deg, var(--gold-deep), var(${row.leadAccent}))`,
                    }}
                    animate={{ width: `${Math.min(100, (row.weightedScore / 10) * 100)}%` }}
                    transition={{ type: 'spring', stiffness: 120, damping: 22 }}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
            {partialScores.length === 0 && (
              <p className="text-center text-[var(--fs-small)] text-[var(--text-mute)]">
                Collecting votes…
              </p>
            )}
          </motion.div>
        )}

        {step === 'reveal' && (
          <motion.div
            key="reveal"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="text-center"
          >
            <p className="display-face mb-1 text-[13px] italic text-[var(--gold-hi)]/70">Winner</p>
            <p className="display-face text-[var(--fs-display)] leading-tight text-[var(--gold-hi)]">
              {reveal?.title ?? 'Deciding…'}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
