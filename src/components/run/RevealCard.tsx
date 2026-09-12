'use client';

import { motion } from 'framer-motion';
import { AlertTriangle, ArrowRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DissentList } from '@/components/run/DissentList';
import { ScoreBreakdown } from '@/components/run/ScoreBreakdown';
import type { DissentRow, RevealPayload, RunMetrics } from '@/shared/events';
import type { ProposalScoreDTO } from '@/shared/types';
import { formatUsd } from '@/lib/utils';

/**
 * The reveal card, section 15.3 and section 20 milestone M6.
 *
 * Winner title, description, why it won, score bars per seat, metrics — and,
 * given equal billing, the dissent. Section 12.4 is explicit that dissent is a
 * first-class output and not an afterthought: the spec calls it the most
 * interesting part and the product should treat it that way.
 */

export interface RevealCardProps {
  reveal: RevealPayload | null;
  metrics: RunMetrics | null;
  scores: ProposalScoreDTO[];
  dissent: DissentRow[];
  failedSeats: Array<{ seatName: string }>;
}

export function RevealCard({ reveal, metrics, scores, dissent, failedSeats }: RevealCardProps) {
  if (!reveal) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col gap-4"
    >
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <p className="step-label text-[var(--text-mute)]">Winner</p>
            {reveal.deterministicFallback ? (
              <Badge tone="warn" title="Synthesis failed schema validation; rendered from stored scores">
                template fallback
              </Badge>
            ) : null}
          </div>
          <CardTitle className="display-face text-[var(--fs-display)] leading-tight">
            {reveal.title}
          </CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          <p className="text-[13.5px] leading-relaxed text-[var(--text-dim)]">
            {reveal.description}
          </p>

          <section>
            <h4 className="step-label mb-1.5 text-[var(--text-mute)]">Why it won</h4>
            <p className="text-[13px] leading-relaxed text-[var(--text-dim)]">
              {reveal.whyItWon}
            </p>
          </section>

          {reveal.firstSteps.length > 0 && (
            <section>
              <h4 className="step-label mb-2 text-[var(--text-mute)]">First steps</h4>
              <ol className="flex flex-col gap-1.5">
                {reveal.firstSteps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-[var(--text-dim)]">
                    <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--seat-5)]" />
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {reveal.risks.length > 0 && (
            <section>
              <h4 className="step-label mb-2 text-[var(--text-mute)]">Risks</h4>
              <ul className="flex flex-col gap-1.5">
                {reveal.risks.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-[var(--text-dim)]">
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
        <CardHeader>
          <CardTitle className="text-[var(--fs-h2)]">Score breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <ScoreBreakdown scores={scores} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[var(--fs-h2)]">Dissent</CardTitle>
        </CardHeader>
        <CardContent>
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
      <h4 className="step-label mb-2 text-[var(--text-mute)]">Run metrics</h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[12.5px]">
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
