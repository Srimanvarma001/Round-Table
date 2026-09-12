import { describe, expect, it } from 'vitest';

import { parseRunJson, renderRunJson, runExportSchema } from '@/lib/export/json';
import { renderRunMarkdown } from '@/lib/export/markdown';
import type { RunDetailResponse } from '@/shared/types';

/** A synthetic but shape-complete run detail: no database required. */
export function sampleDetail(): RunDetailResponse {
  return {
    run: {
      id: 'run-sample-1',
      seedPrompt: 'A CLI tool for tracking houseplants',
      seedMode: 'specific',
      status: 'completed',
      currentStep: 'done',
      stepIndex: 5,
      round: 1,
      tokensIn: 10000,
      tokensOut: 20000,
      costEstimateUsd: 0.007,
      llmCalls: 29,
      errorCode: null,
      errorMessage: null,
      createdAt: 1789151000000,
      startedAt: 1789151001000,
      completedAt: 1789151123000,
      profileId: 'profile-1',
      agentSnapshot: [
        {
          id: 'agent-me',
          seatKey: 'seat_me',
          name: 'You',
          isMeAgent: true,
          lensPrompt: 'lens',
          provider: 'glm',
          modelId: 'glm-5.3-flash',
          temperature: 0.5,
          rawWeight: 0.25,
          normalisedWeight: 0.25,
          accentColor: '#F0B429',
          accentToken: '--seat-1',
          orderIndex: 0,
          enabled: true,
        },
      ],
    },
    agents: [],
    proposals: [
      {
        id: 'prop-1',
        agentId: 'agent-me',
        agentName: 'You',
        accentToken: '--seat-1',
        round: 1,
        title: 'Sprout Log',
        description: 'A local-first watering log with reminders.',
        rationale: 'Ships in a weekend.',
        feasibilityWeeks: 2,
        parentProposalId: null,
        status: 'active',
        createdAt: 1789151002000,
      },
    ],
    critiques: [
      {
        id: 'crit-1',
        agentId: 'agent-contra',
        agentName: 'The Contrarian',
        accentToken: '--seat-6',
        targetProposalId: 'prop-1',
        stance: 'attack',
        comment: 'Reminders rot within a month.',
        round: 1,
      },
    ],
    votes: [
      {
        id: 'vote-1',
        agentId: 'agent-me',
        agentName: 'You',
        accentToken: '--seat-1',
        proposalId: 'prop-1',
        score: 8,
        weightAtVote: 0.25,
        weightedScore: 2.0,
        comment: 'Finishable and useful.',
      },
    ],
    scores: [
      {
        proposalId: 'prop-1',
        title: 'Sprout Log',
        finalScore: 8.0,
        meanScore: 8.0,
        voteCount: 1,
        leadAccent: '--seat-1',
        perSeat: [
          { agentId: 'agent-me', seatName: 'You', accentToken: '--seat-1', score: 8, weighted: 2.0 },
        ],
      },
    ],
    metrics: {
      winnerScore: 8.0,
      scoreSpread: 0,
      meAlignment: true,
      dissentCount: 0,
      distinctness: 1,
      totalCostUsd: 0.007,
      failedSeats: [],
    },
    reveal: {
      title: 'Sprout Log',
      description: 'A local-first watering log with reminders, built in a weekend.',
      whyItWon: 'The only proposal every seat could finish.',
      firstSteps: [' scaffold the CLI', 'add the reminder loop'],
      risks: ['Reminder fatigue'],
      proposalId: 'prop-1',
    },
    dissent: [],
    partialScores: [],
    failedSeats: [],
  };
}

describe('markdown export', () => {
  it('contains every section section 18.3 requires', () => {
    const md = renderRunMarkdown(sampleDetail());
    expect(md).toContain('# Round Table — A CLI tool for tracking houseplants');
    expect(md).toContain('Profile version: profile-1');
    expect(md).toContain('## Seats');
    expect(md).toContain('## Proposals');
    expect(md).toContain('Sprout Log');
    expect(md).toContain('*You, round 1*');
    expect(md).toContain('## Critiques');
    expect(md).toContain('The Contrarian');
    expect(md).toContain('## Vote');
    expect(md).toContain('weight 25.0%');
    expect(md).toContain('## Dissent');
    expect(md).toContain('## Metrics');
    expect(md).toContain('## Winner');
    expect(md).toContain('**Why it won.**');
  });

  it('groups critiques by their target proposal', () => {
    const md = renderRunMarkdown(sampleDetail());
    expect(md).toContain('### On "Sprout Log"');
  });
});

describe('json export', () => {
  it('round-trips against the schema', () => {
    const doc = renderRunJson(sampleDetail());
    const parsed = runExportSchema.safeParse(JSON.parse(JSON.stringify(doc)));
    expect(parsed.success).toBe(true);
    expect(parseRunJson(JSON.parse(JSON.stringify(doc))).run.id).toBe('run-sample-1');
  });

  it('rejects a document missing the run block', () => {
    expect(() => parseRunJson({ proposals: [] })).toThrow();
  });
});
