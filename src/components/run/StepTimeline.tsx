'use client';

import { Check, Minus } from 'lucide-react';

import { STEP_NAMES, type StepName } from '@/shared/constants';

/**
 * The five-node step timeline, section 15.3 and the centre-column spec of
 * section 16.7.
 *
 * State is never encoded in colour alone: each node carries a text label and,
 * where relevant, an icon (section 16.12).
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
    <ol className="flex items-center gap-1" aria-label="Run steps">
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
          <li key={name} className="flex items-center gap-1">
            {i > 0 ? (
              <span
                aria-hidden="true"
                className="h-px w-4"
                style={{ background: complete || active ? 'var(--line-strong)' : 'var(--line)' }}
              />
            ) : null}
            <button
              type="button"
              onClick={onSeek ? () => onSeek(name) : undefined}
              disabled={!onSeek}
              aria-current={active ? 'step' : undefined}
              className={[
                'flex items-center gap-1.5 rounded-[var(--radius-pill)] border px-2.5 py-1',
                'text-[11px] transition-colors',
                onSeek ? 'cursor-pointer hover:border-[var(--line-strong)]' : 'cursor-default',
                active
                  ? 'border-[var(--seat-5)] bg-[var(--seat-5)]/10 text-[var(--text)]'
                  : complete
                    ? 'border-[var(--line-strong)] text-[var(--text-dim)]'
                    : skipped
                      ? 'border-[var(--line)] text-[var(--text-mute)]'
                      : 'border-[var(--line)] text-[var(--text-mute)]',
              ].join(' ')}
            >
              <span className="step-label">{name}</span>
              {complete ? (
                <Check className="h-3 w-3 text-[var(--ok)]" aria-label="complete" />
              ) : skipped ? (
                <Minus className="h-3 w-3" aria-label="skipped" />
              ) : active ? (
                <span
                  className="h-1.5 w-1.5 rounded-[var(--radius-pill)] bg-[var(--seat-5)]"
                  aria-label="in progress"
                />
              ) : null}
              <span className="sr-only-live">{status}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
