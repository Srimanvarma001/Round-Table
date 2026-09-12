import 'server-only';

import { matchProposalByTitle } from '@/lib/agents/weights';
import type { ProposalRow } from '@/lib/db/schema';
import type { PartialScore, RevealPayload, StepSummary } from '@/shared/events';
import type { StepName } from '@/shared/constants';

import {
  activeProposals,
  agentById,
  buildAgentRequest,
  buildScoreboard,
  debateTaskText,
  enabledSeats,
  ensureSearchResults,
  partialScoresFrom,
  proposeTaskText,
  refineTaskText,
  revealTaskText,
  seatNameFor,
  synthesisSeat,
  voteTaskText,
  winnerDissentRows,
  type RunContext,
  type StepModule,
  type StepResult,
  type StepTask,
} from './context';
import {
  ProposeSchema,
  DebateSchema,
  RefineSchema,
  VoteSchema,
  RevealSchema,
  type ProposePayload,
  type DebatePayload,
  type RefinePayload,
  type VotePayload,
} from './schemas';
import { refineTaskKey, SYNTHESIS_AGENT_ID, taskKey } from './taskKey';

/**
 * The five step modules, section 11.3.
 *
 * A module decides two things only: which tasks exist for the step, and what a
 * validated result means for the run's artefacts. Every other concern — prompt
 * assembly, digests, persistence, events, retries, budget — belongs to the
 * engine (`engine.ts`) or the context (`context.ts`), which is what keeps the
 * five steps from drifting (section 9.3).
 *
 * `applyResult` is only ever invoked for a task whose idempotency key was not
 * already recorded (section 11.6), so it can insert freely.
 */

// ---------------------------------------------------------------------------
// Propose — one call per enabled seat
// ---------------------------------------------------------------------------

export const proposeStep: StepModule = {
  name: 'propose',

  buildTasks(ctx: RunContext): StepTask[] {
    return enabledSeats(ctx).map((seat) => {
      const key = taskKey({
        runId: ctx.runId,
        step: 'propose',
        agentId: seat.id,
        round: ctx.run.round,
      });

      return {
        step: 'propose' as const,
        agentId: seat.id,
        taskKey: key,
        schema: ProposeSchema,
        buildRequest: (c) => buildAgentRequest(c, seat, 'propose', proposeTaskText(c, seat)),
        onDelta: () => {},
        applyResult: async (c, result) => {
          const payload = result.parsed as ProposePayload;

          if (payload.proposals.length === 0) {
            // Section B.1: "return an empty result rather than filler" — an
            // empty list is a legitimate answer, recorded as a warning.
            c.warnings.push(`${seat.name} proposed nothing.`);
            return;
          }

          // Appendix A.1: "one or two entries". Anything past two is truncated
          // by the step module rather than rejected by the schema.
          for (const draft of payload.proposals.slice(0, 2)) {
            if (!draft.title || !draft.description) {
              c.warnings.push(
                `${seat.name} returned a proposal with no title or description; it was dropped.`,
              );
              continue;
            }
            c.persist.insertProposal({
              agentId: seat.id,
              round: c.run.round,
              title: draft.title,
              description: draft.description,
              rationale: draft.rationale,
              feasibilityWeeks: draft.feasibility_weeks,
              parentProposalId: null,
            });
          }
        },
      };
    });
  },

  async onStepComplete(ctx: RunContext): Promise<void> {
    // A table that cannot vote on at least three ideas is a shortfall worth
    // naming on the reveal card; recording it beats inventing proposals.
    const active = activeProposals(ctx).length;
    if (active < 3) {
      ctx.warnings.push(
        `Only ${active} proposal${active === 1 ? '' : 's'} reached the debate.`,
      );
    }
  },

  isComplete(ctx: RunContext): boolean {
    return activeProposals(ctx).length > 0;
  },
};

// ---------------------------------------------------------------------------
// Debate — one call per enabled seat
// ---------------------------------------------------------------------------

export const debateStep: StepModule = {
  name: 'debate',

  buildTasks(ctx: RunContext): StepTask[] {
    return enabledSeats(ctx).map((seat) => {
      const key = taskKey({
        runId: ctx.runId,
        step: 'debate',
        agentId: seat.id,
        round: ctx.run.round,
      });

      return {
        step: 'debate' as const,
        agentId: seat.id,
        taskKey: key,
        schema: DebateSchema,
        buildRequest: (c) => buildAgentRequest(c, seat, 'debate', debateTaskText(c, seat)),
        onDelta: () => {},
        applyResult: async (c, result) => {
          const payload = result.parsed as DebatePayload;
          const proposals = activeProposals(c);
          const cap = c.settings.maxCritiquesPerAgent;

          let recorded = 0;
          for (const draft of payload.critiques) {
            if (recorded >= cap) break;

            // Appendix A.2: "must match a title from the proposals list".
            // Resolution is a normalised match; an unresolvable critique is
            // dropped with a warning rather than retried (section 17.3).
            const target = matchProposalByTitle(proposals, draft.target_title);
            if (!target) {
              c.warnings.push(
                `${seat.name} critiqued "${draft.target_title}", which matched no live proposal; it was dropped.`,
              );
              continue;
            }
            if (!draft.comment) continue;

            c.persist.insertCritique({
              agentId: seat.id,
              targetProposalId: target.id,
              stance: draft.stance,
              comment: draft.comment,
              round: c.run.round,
            });
            recorded += 1;
          }

          // Section A.2's "at least one must target a proposal the agent did
          // not author" is a quality requirement, verified after resolution:
          // a violation costs a warning, not a retry.
          if (payload.critiques.length > 0) {
            const allOwn = payload.critiques.every((draft) => {
              const target = matchProposalByTitle(proposals, draft.target_title);
              return target ? target.agentId === seat.id : true;
            });
            if (allOwn) {
              c.warnings.push(`${seat.name} critiqued only their own proposals.`);
            }
          }
        },
      };
    });
  },

  async onStepComplete(ctx: RunContext): Promise<void> {
    if (ctx.critiques.length === 0) {
      ctx.warnings.push('No critiques were recorded; refine will be skipped.');
    }
  },

  isComplete(ctx: RunContext): boolean {
    return true;
  },
};

// ---------------------------------------------------------------------------
// Refine — one call per critiqued author, capped
// ---------------------------------------------------------------------------

export const refineStep: StepModule = {
  name: 'refine',

  /**
   * Section 11.2: refine runs only when at least one proposal received a
   * critique. Skipping without a `step.started` keeps the timeline honest.
   */
  shouldSkip(ctx: RunContext): boolean {
    return ctx.critiques.length === 0;
  },

  buildTasks(ctx: RunContext): StepTask[] {
    // One task per AUTHOR of a critiqued proposal, busiest first, capped at
    // `maxRefineSeats` (section 11.3).
    const targets = activeProposals(ctx)
      .map((proposal) => ({
        proposal,
        author: agentById(ctx, proposal.agentId),
        critiques: ctx.critiques.filter((c) => c.targetProposalId === proposal.id).length,
      }))
      .filter((entry): entry is { proposal: ProposalRow; author: NonNullable<ReturnType<typeof agentById>>; critiques: number } =>
        Boolean(entry.author) && entry.critiques > 0)
      .sort((a, b) => b.critiques - a.critiques || a.proposal.createdAt - b.proposal.createdAt)
      .slice(0, ctx.settings.maxRefineSeats);

    return targets.map(({ proposal, author }) => {
      const key = refineTaskKey({
        runId: ctx.runId,
        step: 'refine',
        agentId: author.id,
        round: ctx.run.round,
        proposalId: proposal.id,
      });

      return {
        step: 'refine' as const,
        agentId: author.id,
        taskKey: key,
        schema: RefineSchema,
        buildRequest: (c) => buildAgentRequest(c, author, 'refine', refineTaskText(c, proposal)),
        onDelta: () => {},
        applyResult: async (c, result) => {
          const payload = result.parsed as RefinePayload;
          // A.3: `refined: null` means the proposal stands.
          if (!payload.refined) return;

          const refined = payload.refined;
          if (!refined.title || !refined.description) {
            c.warnings.push(
              `${author.name}'s revision of "${proposal.title}" had no title or description and was dropped.`,
            );
            return;
          }

          // Resolve every merge target BEFORE retiring anything, so the base
          // and the absorbed proposals are retired exactly once and the new
          // proposal lands in one consistent write.
          const mergeTargets = refined.merges_proposal_titles
            .map((title) => matchProposalByTitle(activeProposals(c), title))
            .filter((t): t is ProposalRow => t !== null && t.id !== proposal.id);

          const retiredIds = new Set<string>([proposal.id, ...mergeTargets.map((t) => t.id)]);

          c.persist.insertProposal({
            agentId: author.id,
            round: c.run.round + 1,
            title: refined.title,
            description: refined.description,
            rationale: refined.rationale,
            feasibilityWeeks: proposal.feasibilityWeeks,
            parentProposalId: proposal.id,
          });

          for (const retiredId of retiredIds) {
            c.persist.setProposalStatus(retiredId, 'merged');
          }
        },
      };
    });
  },

  async onStepComplete(ctx: RunContext): Promise<void> {
    if (!ctx.proposals.some((p) => p.parentProposalId !== null)) {
      ctx.warnings.push('No proposal was revised or merged during refine.');
    }
  },

  isComplete(): boolean {
    return true;
  },
};

// ---------------------------------------------------------------------------
// Vote — one call per enabled seat, covering every survivor
// ---------------------------------------------------------------------------

export const voteStep: StepModule = {
  name: 'vote',

  buildTasks(ctx: RunContext): StepTask[] {
    return enabledSeats(ctx).map((seat) => {
      const key = taskKey({
        runId: ctx.runId,
        step: 'vote',
        agentId: seat.id,
        round: ctx.run.round,
      });

      return {
        step: 'vote' as const,
        agentId: seat.id,
        taskKey: key,
        schema: VoteSchema,
        buildRequest: (c) => buildAgentRequest(c, seat, 'vote', voteTaskText(c, seat)),
        onDelta: () => {},
        // Section 16.7: vote-step completions carry the incremental plinth.
        enrichDone: (c) => ({ partialScores: partialScoresFrom(c) }),
        applyResult: async (c, result) => {
          const payload = result.parsed as VotePayload;
          const proposals = activeProposals(c);
          const weight = c.normalisedWeights[seat.id] ?? 0;

          let recorded = 0;
          for (const draft of payload.votes) {
            const target = matchProposalByTitle(proposals, draft.proposal_title);
            if (!target) {
              c.warnings.push(
                `${seat.name} voted on "${draft.proposal_title}", which matched no live proposal; it was dropped.`,
              );
              continue;
            }

            // One vote per agent per proposal is enforced by the unique index;
            // the upsert makes a resume-safe re-apply update in place.
            c.persist.upsertVote({
              agentId: seat.id,
              proposalId: target.id,
              score: draft.score,
              weightAtVote: weight,
              weightedScore: draft.score * weight,
              comment: draft.comment,
            });
            recorded += 1;
          }

          if (recorded === 0 && proposals.length > 0) {
            c.warnings.push(`${seat.name} recorded no votes.`);
          }
        },
      };
    });
  },

  async onStepComplete(_ctx: RunContext): Promise<void> {},

  isComplete(): boolean {
    return true;
  },
};

// ---------------------------------------------------------------------------
// Reveal — one non-agent synthesis call
// ---------------------------------------------------------------------------

export const revealStep: StepModule = {
  name: 'reveal',

  buildTasks(ctx: RunContext): StepTask[] {
    const seat = synthesisSeat(ctx);
    const key = taskKey({
      runId: ctx.runId,
      step: 'reveal',
      agentId: SYNTHESIS_AGENT_ID,
      round: ctx.run.round,
    });

    return [
      {
        step: 'reveal',
        agentId: SYNTHESIS_AGENT_ID,
        taskKey: key,
        schema: RevealSchema,
        buildRequest: (c) => buildAgentRequest(c, seat, 'reveal', revealTaskText(c)),
        onDelta: () => {},
        // Section 11.3: "1 total, non-agent". Non-streaming buys the
        // provider's real token usage and costs nothing in UX — no avatar
        // represents this call in the ring.
        stream: false,
        applyResult: async (c, result) => {
          const payload = result.parsed as {
            title: string;
            description: string;
            why_it_won: string;
            first_steps: string[];
            risks: string[];
          };
          const winner = buildScoreboard(c)[0] ?? null;

          c.reveal = {
            title: payload.title,
            description: payload.description,
            whyItWon: payload.why_it_won,
            firstSteps: payload.first_steps,
            risks: payload.risks,
            proposalId: winner?.proposalId ?? null,
          };
        },
      },
    ];
  },

  async onStepComplete(ctx: RunContext): Promise<void> {
    // Section 17.4: if the synthesis failed twice, the run still completes —
    // with the deterministic fallback card built from the vote record.
    if (!ctx.reveal) {
      ctx.reveal = deterministicReveal(ctx);
      ctx.warnings.push(
        'The reveal synthesis failed; the winner card was assembled from the vote record.',
      );
    }
  },

  isComplete(ctx: RunContext): boolean {
    return ctx.reveal !== null;
  },
};

// ---------------------------------------------------------------------------

export function stepModules(): readonly StepModule[] {
  return [proposeStep, debateStep, refineStep, voteStep, revealStep];
}

export function moduleForStep(step: StepName): StepModule | undefined {
  return stepModules().find((m) => m.name === step);
}

/**
 * Section 17.4's deterministic fallback: the winner expanded from stored rows
 * only. The card declares itself via `deterministicFallback: true`, which the
 * reveal card renders as a notice.
 */
export function deterministicReveal(ctx: RunContext): RevealPayload {
  const winner = buildScoreboard(ctx)[0] ?? null;

  if (!winner) {
    return {
      title: 'No proposal survived',
      description:
        'The table completed without a surviving proposal. This card was assembled from the run record rather than generated.',
      whyItWon:
        'No winner was selectable: no proposal reached the vote-eligible set, so there is nothing to expand.',
      firstSteps: ['Re-run the table with a narrower or more concrete seed.'],
      risks: ['The seed may be too vague for any lens to propose against.'],
      proposalId: null,
      deterministicFallback: true,
    };
  }

  const dissent = winnerDissentRows(ctx, winner);
  const top = winner.perSeat.slice().sort((a, b) => b.weighted - a.weighted)[0];

  return {
    title: winner.title,
    description: winner.description,
    whyItWon:
      `Assembled from the vote record: weighted ${winner.finalScore.toFixed(3)} across ` +
      `${winner.voteCount} vote${winner.voteCount === 1 ? '' : 's'} (mean ${winner.meanScore.toFixed(2)}).` +
      (top ? ` Strongest support came from ${top.seatName} (${top.score}/10).` : ''),
    firstSteps: [
      `Start from the proposal as written by ${winner.authorName}: ${winner.description}`,
    ],
    risks:
      dissent.length > 0
        ? dissent.map((d) => `${d.seatName} scored it ${d.score}/10: ${d.comment}`)
        : ['No dissent was recorded; treat the absence of criticism with suspicion rather than comfort.'],
    proposalId: winner.proposalId,
    deterministicFallback: true,
  };
}

// Re-exports so the engine imports this module alone for the step machinery.
export type { RunContext, StepResult, StepSummary, PartialScore };
export { ensureSearchResults, seatNameFor };
