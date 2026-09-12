'use client';

import type { DissentRow } from '@/shared/events';

/**
 * Dissenting seats with score and comment, section 12.4 and section 15.3.
 *
 * An agent is a dissenter on a proposal when its score is at or below
 * `mean(scores) - 2` for that proposal, or when it scored the winning proposal
 * below 5.
 *
 * Dissent is a first-class output, not an afterthought: the spec calls it the
 * most interesting part and the product should treat it that way. So it gets
 * equal billing on the reveal card rather than being tucked into a footnote.
 */
export function DissentList({ dissent }: { dissent: DissentRow[] }) {
  if (dissent.length === 0) {
    return (
      <p className="text-[13px] text-[var(--text-mute)]">
        No dissent. Every seat scored the winner within two points of the table mean.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2.5">
      {dissent.map((row) => (
        <li
          key={`${row.agentId}-${row.score}`}
          className="rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--bg-elev-3)] px-3 py-2.5"
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-[var(--radius-pill)]"
              style={{ background: `var(${row.accentToken})` }}
            />
            <span className="text-[13px] font-medium text-[var(--text)]">{row.seatName}</span>
            <span
              className="tnum ml-auto rounded-[var(--radius-pill)] border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--text-dim)]"
              aria-label={`scored ${row.score} out of 10`}
            >
              {row.score}/10
            </span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text-dim)]">
            {row.comment}
          </p>
        </li>
      ))}
    </ul>
  );
}
