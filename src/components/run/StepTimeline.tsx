'use client';

import { Check, Minus } from 'lucide-react';

import { STEP_NAMES, type StepName } from '@/shared/constants';

/**
 * The five-node step tracker: a cigar-band strip, not pill buttons.
 *
 * Steps are genuinely sequential (propose, debate, refine, vote, reveal) so
 * numbered markers are legitimate rather than decorative. Active step fills
 * gold with a soft glow; completed steps carry a dim gold outline with a
 * check; skipped show a dash; upcoming stay muted. State is never encoded in
 * colour alone: each node carries its label and an icon where relevant.
 */

export interface StepTimelineProps {
  step: StepName;
  completedSteps: StepName[];
  /** Steps the run config will skip, so they render as skipped, not pending. */
  skippedSteps?: StepName[];
  onSeek?: (step: StepName) => void;
}

export function StepTimeline({
  step,
  completedSteps,
  skippedSteps = [],
  onSeek,
}: StepTimelineProps) {
  return (
    <ol
      aria-label="Run steps"
      className="flex items-stretch gap-0 overflow-hidden rounded-[var(--radius-pill)] border border-[var(--line-strong)] bg-[var(--recess-bg)]"
      style={{ boxShadow: 'var(--recess-shadow)' }}
    >
      {STEP_NAMES.map((name, i) => {
        const skipped = skippedSteps.includes(name);
        const complete = completedSteps.includes(name);
        const active = step === name;

        const status = skipped
          ? 'skipped'
          : complete
            ? 'complete'
            : active
              ? 'active'
              : 'pending';

        return (
          <li key={name} className="flex items-stretch">
            {i > 0 ? <span aria-hidden="true" className="w-px self-stretch bg-[var(--line)]" /> : null}
            <button
              type="button"
              onClick={onSeek ? () => onSeek(name) : undefined}
              disabled={!onSeek}
              aria-current={active ? 'step' : undefined}
              className={[
                'flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] transition-colors',
                onSeek ? 'cursor-pointer' : 'cursor-default',
                active
                  ? 'bg-[var(--gold)] font-semibold text-[var(--bg)]'
                  : complete
                    ? 'text-[var(--gold-hi)]'
                    : skipped
                      ? 'text-[var(--text-mute)]'
                      : 'text-[var(--text-mute)]',
              ].join(' ')}
              style={
                active
                  ? { boxShadow: '0 0 14px rgba(201,151,63,0.45)' }
                  : undefined
              }
              title={`Step ${i + 1} of ${STEP_NAMES.length}, ${name}, ${status}`}
            >
              <span
                aria-hidden="true"
                className={[
                  'tnum flex h-4 w-4 items-center justify-center rounded-[var(--radius-pill)] border text-[10px] font-semibold',
                  active
                    ? 'border-[var(--bg)]/40 text-[var(--bg)]'
                    : complete
                      ? 'border-[var(--gold)]/50 text-[var(--gold-hi)]'
                      : 'border-[var(--line-strong)] text-[var(--text-mute)]',
                ].join(' ')}
              >
                {complete ? (
                  <Check className="h-2.5 w-2.5" aria-label="complete" />
                ) : skipped ? (
                  <Minus className="h-2.5 w-2.5" aria-label="skipped" />
                ) : (
                  i + 1
                )}
              </span>
              <span className="capitalize">{name}</span>
              <span className="sr-only-live">{status}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
