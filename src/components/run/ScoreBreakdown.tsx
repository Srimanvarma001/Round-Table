'use client';

import { motion } from 'framer-motion';

import type { ProposalScoreDTO } from '@/shared/types';
import { MAX_SCORE } from '@/shared/constants';
import { truncate } from '@/lib/utils';

/**
 * Stacked bar per proposal by seat colour, from the stored `weighted_score`
 * values (section 15.3).
 *
 * These are the server's numbers. Section 15.2: the client never computes
 * weighted scores.
 */
export function ScoreBreakdown({ scores }: { scores: ProposalScoreDTO[] }) {
  if (scores.length === 0) {
    return <p className="text-[13px] text-[var(--text-mute)]">No votes recorded.</p>;
  }

  // Scale every bar against the best score so the comparison is legible even
  // when the whole table clustered low.
  const best = Math.max(...scores.map((s) => s.finalScore), 0.0001);

  return (
    <ul className="flex flex-col gap-4">
      {scores.map((row) => (
        <li key={row.proposalId}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text)]">
              {truncate(row.title, 70)}
            </span>
            <span className="tnum shrink-0 text-[13px] font-semibold text-[var(--text)]">
              {/* The accessible name carries the final value from the first
                  render; any animated counting is presentation only
                  (section 16.12). */}
              <span aria-label={`final score ${row.finalScore.toFixed(3)}`}>
                {row.finalScore.toFixed(3)}
              </span>
            </span>
          </div>

          {/* The bar is one element per proposal, not eight, so it is the one
              documented exception to the "never animate width" rule in
              section 16.13. */}
          <div
            className="mt-1.5 flex h-2.5 w-full overflow-hidden rounded-[var(--radius-pill)] bg-[var(--bg-elev-3)]"
            role="img"
            aria-label={`Score composition across ${row.perSeat.length} seats`}
          >
            {row.perSeat
              .slice()
              .sort((a, b) => b.weighted - a.weighted)
              .map((seat, i) => (
                <motion.span
                  key={seat.agentId}
                  initial={{ width: 0 }}
                  animate={{ width: `${(seat.weighted / best) * 100}%` }}
                  transition={{ duration: 0.5, delay: i * 0.03, ease: [0.22, 1, 0.36, 1] }}
                  style={{ background: `var(${seat.accentToken})` }}
                  title={`${seat.seatName}: ${seat.score}/10 → ${seat.weighted.toFixed(3)}`}
                />
              ))}
          </div>

          <p className="tnum mt-1 text-[11px] text-[var(--text-mute)]">
            {row.voteCount} votes · mean {row.meanScore.toFixed(2)}/{MAX_SCORE}
          </p>
        </li>
      ))}
    </ul>
  );
}
