'use client';

import { ArrowDown, ArrowRight, ArrowUp, Minus } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime, formatDuration, formatUsd, humanise } from '@/lib/utils';
import type { RunCompareResponse, RunDetailResponse, AgentSnapshotEntry } from '@/shared/types';

/**
 * Two-run comparison, section 18.4.
 *
 * "`/runs/compare?a=&b=` renders two runs side by side: seed prompts, winner
 *  titles and scores, the metric table from section 12.5 with deltas, and the
 *  seats that changed between the snapshot configs. The point of the view is
 *  answering 'did changing my profile or the seed actually change the
 *  outcome', so the weight and profile diffs are rendered FIRST, above the
 *  results."
 *
 * That ordering is the whole design of this component: `What changed` comes
 * before `What came out`, because a result without its inputs is not an
 * experiment. Deltas are always `B − A`, stated in words as well as shown.
 *
 * A delta is never coloured as good or bad. Section 16.12 forbids encoding
 * state in colour alone, and for most of these metrics "up" is not "better" —
 * a higher score spread is more argument, not a worse run — so the direction is
 * carried by a signed number and an arrow instead.
 */

export interface RunCompareProps {
  data: RunCompareResponse;
}

export function RunCompare({ data }: RunCompareProps) {
  const { a, b, deltas, seatConfigDiff } = data;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-labelledby="compare-changed">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="compare-changed" className="text-[var(--fs-h2)] font-semibold text-[var(--text)]">
            What changed
          </h2>
          <p className="text-[12px] text-[var(--text-mute)]">
            Every difference between the two stored configurations, read from the frozen snapshot
            each run was started with.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <RunIdentityCard side="A" detail={a} />
          <RunIdentityCard side="B" detail={b} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-[var(--fs-h2)]">Seat configuration diff</CardTitle>
            <p className="text-[var(--fs-small)] text-[var(--text-dim)]">
              Snapshot fields that differ. Weights are the normalised values each seat actually
              voted with; a seat missing from this table voted identically in both runs.
            </p>
          </CardHeader>
          <CardContent>
            {seatConfigDiff.length === 0 ? (
              <p className="text-[13px] text-[var(--text-mute)]">
                Identical seat configuration. Any difference in the outcome came from the seed
                prompt, the profile, or the models themselves.
              </p>
            ) : (
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-[var(--line)]">
                    <th scope="col" className="step-label px-3 py-2 font-medium text-[var(--text-mute)]">
                      Seat
                    </th>
                    <th scope="col" className="step-label px-3 py-2 font-medium text-[var(--text-mute)]">
                      Field
                    </th>
                    <th scope="col" className="step-label px-3 py-2 font-medium text-[var(--text-mute)]">
                      A
                    </th>
                    <th scope="col" className="step-label px-3 py-2 font-medium text-[var(--text-mute)]">
                      B
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {seatConfigDiff.map((row, i) => (
                    <tr
                      key={`${row.seatKey}-${row.field}-${i}`}
                      className="border-b border-[var(--line)] last:border-b-0"
                    >
                      <td className="px-3 py-2 text-[12.5px] text-[var(--text)]">{row.name}</td>
                      <td className="px-3 py-2 text-[12.5px] text-[var(--text-dim)]">
                        {humanise(row.field)}
                      </td>
                      <td className="px-3 py-2 text-[12.5px] text-[var(--text-dim)]">
                        <DiffSide value={row.a} />
                      </td>
                      <td className="px-3 py-2 text-[12.5px] text-[var(--text)]">
                        <DiffSide value={row.b} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="compare-results">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="compare-results" className="text-[var(--fs-h2)] font-semibold text-[var(--text)]">
            What came out
          </h2>
          <p className="text-[12px] text-[var(--text-mute)]">
            Every delta is <span className="tnum">B − A</span>.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <WinnerCard side="A" detail={a} />
          <WinnerCard side="B" detail={b} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-[var(--fs-h2)]">Derived run metrics</CardTitle>
            <p className="text-[var(--fs-small)] text-[var(--text-dim)]">
              Section 12.5. These are the stored numbers; nothing is recomputed in the browser.
            </p>
          </CardHeader>
          <CardContent>
            {deltas.length === 0 ? (
              <p className="text-[13px] text-[var(--text-mute)]">
                No metric rows were returned for this pair. Both runs may still be in progress.
              </p>
            ) : (
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-[var(--line)]">
                    <th scope="col" className="step-label px-3 py-2 font-medium text-[var(--text-mute)]">
                      Metric
                    </th>
                    <th scope="col" className="step-label px-3 py-2 text-right font-medium text-[var(--text-mute)]">
                      A
                    </th>
                    <th scope="col" className="step-label px-3 py-2 text-right font-medium text-[var(--text-mute)]">
                      B
                    </th>
                    <th scope="col" className="step-label px-3 py-2 text-right font-medium text-[var(--text-mute)]">
                      Delta
                    </th>
                    <th scope="col" className="step-label px-3 py-2 pl-6 font-medium text-[var(--text-mute)]">
                      Reading
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {deltas.map((row) => (
                    <tr key={row.metric} className="border-b border-[var(--line)] last:border-b-0">
                      <td className="px-3 py-2 text-[12.5px] text-[var(--text)]">
                        {metricLabel(row.metric)}
                      </td>
                      <td className="tnum px-3 py-2 text-right text-[12.5px] text-[var(--text-dim)]">
                        {metricValue(row.metric, row.a)}
                      </td>
                      <td className="tnum px-3 py-2 text-right text-[12.5px] text-[var(--text)]">
                        {metricValue(row.metric, row.b)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <DeltaCell metric={row.metric} delta={row.delta} />
                      </td>
                      <td className="px-3 py-2 pl-6 text-[11.5px] text-[var(--text-mute)]">
                        {metricHint(row.metric)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

// --- Sub-views --------------------------------------------------------------

function RunIdentityCard({ side, detail }: { side: 'A' | 'B'; detail: RunDetailResponse }) {
  const { run } = detail;
  const seats = run.agentSnapshot ?? [];
  const enabled = seats.filter((s) => s.enabled);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <span className="step-label rounded-[var(--radius-pill)] border border-[var(--line)] px-2 py-0.5 text-[var(--text-dim)]">
            Run {side}
          </span>
          <span className="tnum text-[11px] text-[var(--text-mute)]">
            {formatDateTime(run.createdAt)}
          </span>
        </div>
        <p className="mt-1 text-[13.5px] leading-snug text-[var(--text)]">{run.seedPrompt}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-1">
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 text-[12px]">
          <dt className="text-[var(--text-mute)]">Profile version</dt>
          <dd className="tnum text-[var(--text-dim)]">
            {run.profileId ?? 'none — run without a profile'}
          </dd>

          <dt className="text-[var(--text-mute)]">Enabled seats</dt>
          <dd className="tnum text-[var(--text-dim)]">
            {enabled.length} of {seats.length}
          </dd>

          <dt className="text-[var(--text-mute)]">LLM calls</dt>
          <dd className="tnum text-[var(--text-dim)]">{run.llmCalls}</dd>

          <dt className="text-[var(--text-mute)]">Tokens in / out</dt>
          <dd className="tnum text-[var(--text-dim)]">
            {run.tokensIn} / {run.tokensOut}
          </dd>

          <dt className="text-[var(--text-mute)]">Cost</dt>
          <dd className="tnum text-[var(--text-dim)]">{formatUsd(run.costEstimateUsd)}</dd>

          <dt className="text-[var(--text-mute)]">Duration</dt>
          <dd className="tnum text-[var(--text-dim)]">
            {formatDuration(
              run.startedAt != null && run.completedAt != null
                ? run.completedAt - run.startedAt
                : null,
            )}
          </dd>
        </dl>

        <SeatWeights seats={seats} />
      </CardContent>
    </Card>
  );
}

function SeatWeights({ seats }: { seats: AgentSnapshotEntry[] }) {
  const ordered = seats.slice().sort((x, y) => x.orderIndex - y.orderIndex);
  if (ordered.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 border-t border-[var(--line)] pt-2">
      {ordered.map((seat) => (
        <span
          key={seat.id}
          className="flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-[var(--line)] px-2 py-0.5 text-[11px]"
          title={`${seat.provider} · ${seat.modelId} · ${seat.enabled ? 'enabled' : 'disabled'}`}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-[var(--radius-pill)]"
            style={{ background: `var(${seat.accentToken})`, opacity: seat.enabled ? 1 : 0.3 }}
          />
          <span className={seat.enabled ? 'text-[var(--text-dim)]' : 'text-[var(--text-mute)] line-through'}>
            {seat.name}
          </span>
          <span className="tnum text-[var(--text-mute)]">
            {seat.enabled ? `${(seat.normalisedWeight * 100).toFixed(1)}%` : '0%'}
          </span>
        </span>
      ))}
    </div>
  );
}

function WinnerCard({ side, detail }: { side: 'A' | 'B'; detail: RunDetailResponse }) {
  const reveal = detail.reveal;
  const score = detail.metrics?.winnerScore ?? null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <p className="step-label text-[var(--text-mute)]">Winner — run {side}</p>
        <CardTitle className="display-face text-[var(--fs-h2)] leading-snug">
          {reveal?.title ?? 'No winner recorded'}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-1">
        <p className="tnum text-[12.5px] text-[var(--text-dim)]">
          Winning score{' '}
          <span className="font-semibold text-[var(--text)]">
            {score != null ? score.toFixed(3) : '—'}
          </span>
        </p>
        {reveal?.whyItWon ? (
          <p className="text-[12.5px] leading-relaxed text-[var(--text-dim)]">{reveal.whyItWon}</p>
        ) : null}
        {detail.run.errorCode ? (
          <p className="text-[11.5px] text-[var(--danger)]">
            Run ended with {detail.run.errorCode}
            {detail.run.errorMessage ? `: ${detail.run.errorMessage}` : ''}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DiffSide({ value }: { value: string }) {
  if (!value) return <span className="text-[var(--text-mute)]">—</span>;
  return <span>{value}</span>;
}

function DeltaCell({ metric, delta }: { metric: string; delta: number | null }) {
  if (delta == null) {
    return (
      <span className="inline-flex items-center gap-1 text-[12.5px] text-[var(--text-mute)]">
        <Minus className="h-3 w-3" aria-hidden="true" />
        n/a
      </span>
    );
  }

  const rounded = Math.abs(delta) < 1e-9 ? 0 : delta;
  const digits = digitsFor(metric);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '±';
  const Icon = rounded > 0 ? ArrowUp : rounded < 0 ? ArrowDown : ArrowRight;

  return (
    <span className="tnum inline-flex items-center justify-end gap-1 text-[12.5px] text-[var(--text-dim)]">
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span>
        {sign}
        {Math.abs(rounded).toFixed(digits)}
      </span>
      <span className="sr-only-live">
        {rounded === 0 ? 'unchanged' : rounded > 0 ? 'increased' : 'decreased'}
      </span>
    </span>
  );
}

// --- Formatting -------------------------------------------------------------

const METRIC_LABELS: Record<string, string> = {
  winnerscore: 'Winning score',
  scorespread: 'Score spread',
  mealignment: 'Me Agent alignment',
  dissentcount: 'Dissent rows',
  distinctness: 'Distinctness',
  totalcostusd: 'Total cost',
  llmcalls: 'LLM calls',
  tokensin: 'Tokens in',
  tokensout: 'Tokens out',
};

const METRIC_HINTS: Record<string, string> = {
  winnerscore: 'Final weighted score of the winning idea',
  scorespread: 'Highest minus lowest final score, a consensus measure',
  mealignment: 'Whether the winner was also your seat’s top-scored proposal',
  dissentcount: 'Number of dissent rows, section 12.4',
  distinctness: 'Mean pairwise Jaccard similarity; lower is more diverse',
  totalcostusd: 'Sum of call costs',
};

function metricLabel(metric: string): string {
  return METRIC_LABELS[metric.toLowerCase().replace(/[_\s]/g, '')] ?? humanise(metric);
}

function metricHint(metric: string): string {
  return METRIC_HINTS[metric.toLowerCase().replace(/[_\s]/g, '')] ?? '';
}

function digitsFor(metric: string): number {
  const key = metric.toLowerCase().replace(/[_\s]/g, '');
  if (key === 'dissentcount' || key === 'llmcalls' || key === 'tokensin' || key === 'tokensout') {
    return 0;
  }
  if (key === 'totalcostusd') return 4;
  return 3;
}

function metricValue(metric: string, value: number | boolean | string | null): string {
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  const key = metric.toLowerCase().replace(/[_\s]/g, '');
  if (key === 'totalcostusd') return formatUsd(value);
  if (key === 'dissentcount' || key === 'llmcalls' || key === 'tokensin' || key === 'tokensout') {
    return value.toFixed(0);
  }
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(3);
}
