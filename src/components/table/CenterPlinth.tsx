'use client';

import { AnimatePresence, motion } from 'framer-motion';

import type { PartialScore, RevealPayload } from '@/shared/events';
import type { StepName } from '@/shared/constants';
import { truncate } from '@/lib/utils';

/**
 * The table centre, section 16.7. It is the focal point of the whole screen, so
 * it carries the run's live state.
 *
 *   propose | step name in small caps, letter-spaced, at 40 percent opacity
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
      className="pointer-events-none absolute left-1/2 top-1/2 z-30 w-[min(46%,520px)] -translate-x-1/2 -translate-y-1/2"
      aria-live="polite"
    >
      <AnimatePresence mode="wait">
        {step === 'propose' && (
          <motion.p
            key="propose"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.4 }}
            exit={{ opacity: 0 }}
            className="step-label text-center text-[var(--text)]"
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
            <span className="text-[var(--fs-h1)] font-semibold text-[var(--text)]">
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
            <p className="step-label text-[var(--text-mute)]">Revising</p>
            {refiningSeatNames.length === 0 ? (
              <p className="text-[var(--fs-small)] text-[var(--text-mute)]">No revisions</p>
            ) : (
              refiningSeatNames.map((name, i) => (
                <motion.span
                  key={name}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.12 }}
                  className="text-[var(--fs-small)] text-[var(--text-dim)]"
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
            className="pointer-events-auto flex flex-col gap-2"
          >
            <p className="step-label mb-1 text-center text-[var(--text-mute)]">
              Live ranking
            </p>
            {/* Rows reorder as votes land, so the user watches consensus form
                rather than reading a final table. This is the single most
                watchable moment of the run and the plinth MUST update
                incrementally per agent.done during the vote step, not once at
                step.completed. The scores come from the server's
                partial_scores payload; the client never computes them. */}
            <AnimatePresence initial={false}>
              {partialScores.map((row) => (
                <motion.div
                  key={row.proposalId}
                  layout
                  transition={{ type: 'spring', stiffness: 260, damping: 30 }}
                  className="rounded-lg border border-[var(--line)] bg-[var(--bg-elev-2)]/85 px-2.5 py-1.5 backdrop-blur-sm"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12px] text-[var(--text-dim)]">
                      {/* Truncated to 46 characters per section 16.7. */}
                      {truncate(row.title, 46)}
                    </span>
                    <span className="tnum shrink-0 text-[12px] font-semibold text-[var(--text)]">
                      {row.weightedScore.toFixed(2)}
                    </span>
                  </div>
                  <motion.div
                    layout
                    className="mt-1 h-1.5 rounded-[var(--radius-pill)]"
                    style={{ background: `var(${row.leadAccent})` }}
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
            <p className="step-label mb-2 text-[var(--text-mute)]">Winner</p>
            <p className="display-face text-[var(--fs-display)] leading-tight text-[var(--text)]">
              {reveal?.title ?? 'Deciding…'}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
