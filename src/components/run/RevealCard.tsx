'use client';

import { motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DissentList } from '@/components/run/DissentList';
import { ScoreBreakdown } from '@/components/run/ScoreBreakdown';
import type { DissentRow, RevealPayload, RunMetrics } from '@/shared/events';
import type { ProposalScoreDTO } from '@/shared/types';
import { formatUsd } from '@/lib/utils';

/**
 * The reveal card.
 *
 * Winner title, description, why it won, score bars per seat, metrics — and,
 * given equal billing, the dissent. Dissent is a first-class output, not an
 * afterthought.
 *
 * In `compact` mode the card renders dense inside the table overlay so the
 * single-viewport constraint holds on completed runs.
 */

export interface RevealCardProps {
  reveal: RevealPayload | null;
  metrics: RunMetrics | null;
  scores: ProposalScoreDTO[];
  dissent: DissentRow[];
  failedSeats: Array<{ seatName: string }>;
  compact?: boolean;
}

export function RevealCard({ reveal, metrics, scores, dissent, failedSeats, compact = false }: RevealCardProps) {
  if (!reveal) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className={compact ? 'flex flex-col gap-2 p-3' : 'flex flex-col gap-4'}
    >
      <Card>
        <CardHeader className={compact ? 'p-3 pb-1.5' : undefined}>
          <div className="flex flex-wrap items-center gap-2">
            <p className="step-label text-[var(--text-mute)]">Winner</p>
            {reveal.deterministicFallback ? (
              <Badge tone="warn" title="Synthesis failed schema validation; rendered from stored scores">
                template fallback
              </Badge>
            ) : null}
          </div>
          <CardTitle className={`display-face leading-tight text-[var(--gold-hi)] ${compact ? 'text-[19px]' : 'text-[var(--fs-display)]'}`}>
            {reveal.title}
          </CardTitle>
        </CardHeader>

        <CardContent className={compact ? 'flex flex-col gap-3 p-3 pt-1.5' : 'flex flex-col gap-5'}>
          <p className="text-[13px] leading-relaxed text-[var(--text-dim)]">
            {reveal.description}
          </p>

          <section>
            <h4 className="step-label mb-1 text-[var(--text-mute)]">Why it won</h4>
            <p className="text-[12.5px] leading-relaxed text-[var(--text-dim)]">
              {reveal.whyItWon}
            </p>
          </section>

          {reveal.firstSteps.length > 0 && (
            <section>
              <h4 className="step-label mb-1.5 text-[var(--text-mute)]">First steps</h4>
              <ol className="flex flex-col gap-1.5">
                {reveal.firstSteps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12.5px] text-[var(--text-dim)]">
                    <span
                      aria-hidden="true"
                      className="mt-[7px] h-1.5 w-1.5 shrink-0 rotate-45 bg-[var(--gold)]"
                    />
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {reveal.risks.length > 0 && (
            <section>
              <h4 className="step-label mb-1.5 text-[var(--text-mute)]">Risks</h4>
              <ul className="flex flex-col gap-1.5">
                {reveal.risks.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12.5px] text-[var(--text-dim)]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warn)]" />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {metrics ? <MetricsTable metrics={metrics} /> : null}

          {failedSeats.length > 0 ? (
            <p className="text-[11.5px] text-[var(--warn)]">
              Seats that failed this run: {failedSeats.map((f) => f.seatName).join(', ')}. The run
              completed with the seats that succeeded.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className={compact ? 'p-3 pb-1.5' : undefined}>
          <CardTitle className="display-face text-[15px]">Score breakdown</CardTitle>
        </CardHeader>
        <CardContent className={compact ? 'p-3 pt-1' : undefined}>
          <ScoreBreakdown scores={scores} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className={compact ? 'p-3 pb-1.5' : undefined}>
          <CardTitle className="display-face text-[15px]">Dissent</CardTitle>
        </CardHeader>
        <CardContent className={compact ? 'p-3 pt-1' : undefined}>
          <DissentList dissent={dissent} />
        </CardContent>
      </Card>
    </motion.div>
  );
}

function MetricsTable({ metrics }: { metrics: RunMetrics }) {
  const rows: Array<[string, string, string?]> = [
    ['Winning score', metrics.winnerScore.toFixed(3)],
    [
      'Score spread',
      metrics.scoreSpread.toFixed(3),
      'Highest minus lowest final score, a consensus measure',
    ],
    [
      'Me Agent alignment',
      metrics.meAlignment ? 'yes' : 'no',
      'Whether the winner was also your seat’s top-scored proposal',
    ],
    ['Dissent rows', String(metrics.dissentCount)],
    [
      'Distinctness',
      metrics.distinctness.toFixed(3),
      'Mean pairwise Jaccard similarity over proposal text; lower is more diverse',
    ],
    ['Total cost', formatUsd(metrics.totalCostUsd)],
  ];

  return (
    <section>
      <h4 className="step-label mb-1.5 text-[var(--text-mute)]">Run metrics</h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[12px]">
        {rows.map(([label, value, hint]) => (
          <div key={label} className="col-span-2 grid grid-cols-subgrid items-baseline py-0.5">
            <dt className="text-[var(--text-mute)]" title={hint}>
              {label}
            </dt>
            <dd className="tnum font-medium text-[var(--text)]">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
