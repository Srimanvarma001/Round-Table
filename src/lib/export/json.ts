import 'server-only';

import { z } from 'zod';

import type { RunDetailResponse } from '@/shared/types';

/**
 * JSON export, section 18.3: the full run detail, round-trippable against a
 * schema. `runExportSchema` is deliberately permissive about EXTRA fields (a
 * newer build may add some) but strict about the ones the importer needs.
 */

const runStatusSchema = z.enum(['created', 'running', 'paused', 'completed', 'failed', 'aborted']);

const snapshotSeatSchema = z.object({
  id: z.string(),
  seatKey: z.string(),
  name: z.string(),
  isMeAgent: z.boolean(),
  lensPrompt: z.string(),
  provider: z.string(),
  modelId: z.string(),
  temperature: z.number(),
  rawWeight: z.number(),
  normalisedWeight: z.number(),
  accentColor: z.string(),
  accentToken: z.string(),
  orderIndex: z.number(),
  enabled: z.boolean(),
});

const proposalSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  accentToken: z.string(),
  round: z.number(),
  title: z.string(),
  description: z.string(),
  rationale: z.string(),
  feasibilityWeeks: z.number().nullable(),
  parentProposalId: z.string().nullable(),
  status: z.enum(['active', 'merged', 'eliminated']),
  createdAt: z.number(),
});

const critiqueSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  accentToken: z.string(),
  targetProposalId: z.string(),
  stance: z.enum(['support', 'attack', 'extend']),
  comment: z.string(),
  round: z.number(),
});

const voteSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  accentToken: z.string(),
  proposalId: z.string(),
  score: z.number(),
  weightAtVote: z.number(),
  weightedScore: z.number(),
  comment: z.string(),
});

const scoreSchema = z.object({
  proposalId: z.string(),
  title: z.string(),
  finalScore: z.number(),
  meanScore: z.number(),
  voteCount: z.number(),
  leadAccent: z.string(),
  perSeat: z.array(
    z.object({
      agentId: z.string(),
      seatName: z.string(),
      accentToken: z.string(),
      score: z.number(),
      weighted: z.number(),
    }),
  ),
});

const metricsSchema = z.object({
  winnerScore: z.number(),
  scoreSpread: z.number(),
  meAlignment: z.boolean(),
  dissentCount: z.number(),
  distinctness: z.number(),
  totalCostUsd: z.number(),
  failedSeats: z.array(z.string()),
});

const revealSchema = z.object({
  title: z.string(),
  description: z.string(),
  whyItWon: z.string(),
  firstSteps: z.array(z.string()),
  risks: z.array(z.string()),
  proposalId: z.string().nullable(),
  deterministicFallback: z.boolean().optional(),
});

/**
 * The export document schema. `run` is required and structurally checked;
 * everything else is required too, because a truncated export is worse than a
 * rejected one — silence about missing artefacts would look like the run had
 * none.
 */
export const runExportSchema = z.object({
  run: z.object({
    id: z.string(),
    seedPrompt: z.string(),
    seedMode: z.enum(['vague', 'specific']),
    status: runStatusSchema,
    currentStep: z.string(),
    stepIndex: z.number(),
    round: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    costEstimateUsd: z.number(),
    llmCalls: z.number(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.number(),
    startedAt: z.number().nullable(),
    completedAt: z.number().nullable(),
    profileId: z.string().nullable(),
    agentSnapshot: z.array(snapshotSeatSchema),
  }),
  agents: z.array(z.unknown()),
  proposals: z.array(proposalSchema),
  critiques: z.array(critiqueSchema),
  votes: z.array(voteSchema),
  scores: z.array(scoreSchema),
  metrics: metricsSchema.nullable(),
  reveal: revealSchema.nullable(),
  dissent: z.array(z.unknown()),
  partialScores: z.array(z.unknown()),
  failedSeats: z.array(z.unknown()),
  events: z.array(z.unknown()).optional(),
});

/** Parse and validate an exported document, throwing a readable error. */
export function parseRunJson(input: unknown): RunDetailResponse {
  const parsed = runExportSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? ' (at "' + issue.path.join('.') + '": ' + issue.message + ')' : '';
    throw new Error('Not a valid run export' + where + '.');
  }
  return parsed.data as RunDetailResponse;
}

/** The export document is the run detail itself; the schema above guards it. */
export function renderRunJson(detail: RunDetailResponse): RunDetailResponse {
  return detail;
}
