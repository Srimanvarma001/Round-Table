import 'server-only';

import type { RunDetailResponse } from '@/shared/types';

/**
 * Markdown export, section 18.3: a standalone readable document with every
 * required section — header, seats, proposals, critiques, votes, dissent,
 * metrics, the winner card and any recorded failures.
 */
export function renderRunMarkdown(detail: RunDetailResponse): string {
  const { run, metrics, reveal, scores, dissent, proposals, critiques, votes, failedSeats } = detail;
  const lines: string[] = [];

  lines.push(`# Round Table — ${run.seedPrompt}`);
  lines.push('');
  lines.push(
    `Status: **${run.status}** · created ${new Date(run.createdAt).toISOString()} · ` +
      `cost ${run.costEstimateUsd.toFixed(4)} USD · ${run.llmCalls} LLM calls · ` +
      `${(run.tokensIn + run.tokensOut).toLocaleString()} tokens` +
      (run.profileId ? ` · Profile version: ${run.profileId}` : ''),
  );

  lines.push('');
  lines.push('## Seats');
  if (run.agentSnapshot.length === 0) lines.push('_No seat snapshot was recorded._');
  for (const seat of run.agentSnapshot) {
    lines.push(
      `- **${seat.name}** (${seat.provider}/${seat.modelId}, weight ${(seat.normalisedWeight * 100).toFixed(1)}%)` +
        `${seat.isMeAgent ? ' — the Me Agent' : ''}${seat.enabled ? '' : ' — disabled'}`,
    );
  }

  lines.push('');
  lines.push('## Proposals');
  if (proposals.length === 0) lines.push('_No proposals were recorded._');
  for (const proposal of proposals) {
    const tag = proposal.status !== 'active' ? ` _(${proposal.status})_` : '';
    lines.push(`### ${proposal.title}${tag}`);
    lines.push(`*${proposal.agentName}, round ${proposal.round}*`);
    lines.push('');
    lines.push(proposal.description);
    if (proposal.rationale) {
      lines.push('');
      lines.push(`> Why: ${proposal.rationale}`);
    }
    if (proposal.feasibilityWeeks !== null) {
      lines.push('');
      lines.push(`Estimated effort: about ${proposal.feasibilityWeeks} weeks.`);
    }
    lines.push('');
  }

  lines.push('');
  lines.push('## Critiques');
  if (critiques.length === 0) {
    lines.push('_No critiques were recorded._');
  } else {
    // Grouped by the proposal they attacked, so the export reads as a
    // conversation about each idea rather than a flat log.
    for (const proposal of proposals) {
      const targeted = critiques.filter((c) => c.targetProposalId === proposal.id);
      if (targeted.length === 0) continue;
      lines.push(`### On "${proposal.title}"`);
      for (const critique of targeted) {
        lines.push(`- **${critique.agentName}** (${critique.stance}): ${critique.comment}`);
      }
      lines.push('');
    }
    const orphans = critiques.filter((c) => !proposals.some((p) => p.id === c.targetProposalId));
    if (orphans.length > 0) {
      lines.push('### On removed proposals');
      for (const critique of orphans) {
        lines.push(`- **${critique.agentName}** (${critique.stance}): ${critique.comment}`);
      }
      lines.push('');
    }
  }

  lines.push('');
  lines.push('## Vote');
  if (scores.length === 0) {
    lines.push('_No votes were recorded._');
  }
  for (const row of scores) {
    lines.push(
      `- **${row.title}** — ${row.finalScore.toFixed(3)} weighted, ` +
        `mean ${row.meanScore.toFixed(2)} from ${row.voteCount} votes`,
    );
    for (const seat of row.perSeat) {
      const raw = votes.find((v) => v.proposalId === row.proposalId && v.agentId === seat.agentId);
      const weightPct = ((raw?.weightAtVote ?? 0) * 100).toFixed(1);
      lines.push(
        `  - ${seat.seatName}: ${seat.score}/10 (weight ${weightPct}%, weighted ${seat.weighted.toFixed(3)})` +
          (raw?.comment ? ` — ${raw.comment}` : ''),
      );
    }
  }

  lines.push('');
  lines.push('## Dissent');
  if (dissent.length === 0) {
    lines.push('_No seat dissented on the winner._');
  }
  for (const row of dissent) {
    lines.push(`- **${row.seatName}** (${row.score}/10): ${row.comment}`);
  }

  if (metrics) {
    lines.push('');
    lines.push('## Metrics');
    lines.push(`- Winner score: ${metrics.winnerScore.toFixed(3)}`);
    lines.push(`- Score spread: ${metrics.scoreSpread.toFixed(3)}`);
    lines.push(`- Me Agent alignment: ${metrics.meAlignment ? 'yes' : 'no'}`);
    lines.push(`- Dissenting seats: ${metrics.dissentCount}`);
    lines.push(`- Distinctness: ${(metrics.distinctness * 100).toFixed(1)}%`);
    if (metrics.failedSeats.length > 0) {
      lines.push(`- Failed seats: ${metrics.failedSeats.join(', ')}`);
    }
  }

  if (reveal) {
    lines.push('');
    lines.push('## Winner');
    lines.push(`### ${reveal.title}`);
    lines.push('');
    lines.push(reveal.description);
    lines.push('');
    lines.push(`**Why it won.** ${reveal.whyItWon}`);
    if (reveal.firstSteps.length > 0) {
      lines.push('');
      lines.push('**First steps.**');
      for (const step of reveal.firstSteps) lines.push(`1. ${step.trim()}`);
    }
    if (reveal.risks.length > 0) {
      lines.push('');
      lines.push('**Risks.**');
      for (const risk of reveal.risks) lines.push(`- ${risk}`);
    }
    if (reveal.deterministicFallback) {
      lines.push('');
      lines.push('_This card was assembled from the vote record; the synthesis call did not complete._');
    }
  }

  if (failedSeats.length > 0) {
    lines.push('');
    lines.push('## Failures');
    for (const f of failedSeats) {
      lines.push(`- ${f.seatName} (${f.code}): ${f.message}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
