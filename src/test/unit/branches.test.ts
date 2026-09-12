import './env';

import { beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../scripts/migrate';
import { getDb } from '@/lib/db/client';
import { getSettingsOrDefaults, putSettings } from '@/lib/db/queries/settings';
import { classifyError } from '@/lib/llm/types';
import { buildScoreboard, partialScoresFrom } from '@/lib/orchestrator/context';
import { schemaForStep, schemaPromptText } from '@/lib/orchestrator/schemas';
import { canonicalJson, computeSourceHash, isEmptySourceHash, shortHash, sourceHashMatches } from '@/lib/profile/hash';
import type { RunContext } from '@/lib/orchestrator/context';

/**
 * Branch coverage for pure helpers: error classification, step schemas, the
 * settings coercion matrix, hashing edges, and the scoreboard with ragged
 * inputs (unknown authors, missing seats, ties, non-voters).
 */

beforeAll(() => {
  runMigrations();
});

describe('classifyError', () => {
  it('maps statuses and transport failures', () => {
    expect(classifyError({ status: 429 })).toMatchObject({ retryable: true, code: 'RATE_LIMITED' });
    expect(classifyError({ status: 503 })).toMatchObject({ retryable: true, code: 'SERVER_ERROR' });
    expect(classifyError({ status: 500 })).toMatchObject({ retryable: true });
    expect(classifyError({ status: 400 })).toMatchObject({ retryable: false, code: 'CLIENT_ERROR' });
    expect(classifyError({ status: 404 })).toMatchObject({ retryable: false });
    expect(classifyError({ code: 'ECONNRESET' })).toMatchObject({ retryable: true });
    expect(classifyError({ code: 'UND_ERR_CONNECT_TIMEOUT' })).toMatchObject({ retryable: true });
    expect(classifyError(new Error('fetch failed'))).toMatchObject({ retryable: true });
    expect(classifyError(new Error('socket hang up'))).toMatchObject({ retryable: true });
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyError(abort)).toMatchObject({ retryable: true });
    expect(classifyError({ code: 'WEIRD' })).toMatchObject({ retryable: false, code: 'WEIRD' });
    expect(classifyError(null)).toMatchObject({ retryable: false, code: 'UNKNOWN' });
    expect(classifyError('a string')).toMatchObject({ retryable: false });
  });
});

describe('step schemas', () => {
  it('names the schema fields verbatim in the prompt text', () => {
    expect(schemaPromptText('propose')).toContain('proposals');
    expect(schemaPromptText('debate')).toContain('target_title');
    expect(schemaPromptText('vote')).toContain('proposal_title');
    expect(schemaPromptText('reveal')).toContain('why_it_won');
    expect(schemaPromptText('refine')).toContain('merges_proposal_titles');
  });

  it('accepts a valid payload per step', () => {
    expect(schemaForStep('propose').safeParse({ proposals: [{ title: 'T', description: 'D', rationale: 'R', feasibility_weeks: 2 }] }).success).toBe(true);
    expect(schemaForStep('debate').safeParse({ critiques: [{ target_title: 'T', stance: 'attack', comment: 'C' }] }).success).toBe(true);
    expect(schemaForStep('refine').safeParse({ refined: null }).success).toBe(true);
    expect(
      schemaForStep('vote').safeParse({ votes: [{ proposal_title: 'T', score: 7, comment: 'C.' }] }).success,
    ).toBe(true);
    expect(
      schemaForStep('reveal').safeParse({ title: 'T', description: 'D', why_it_won: 'W', first_steps: ['a'], risks: ['b'] }).success,
    ).toBe(true);
  });

  it('coerces near-misses instead of burning retries (Appendix A leniency)', () => {
    const propose = schemaForStep('propose').safeParse({ proposals: 'nope' });
    expect(propose.success).toBe(true);
    if (propose.success) expect(propose.data).toEqual({ proposals: [] });

    const stance = schemaForStep('debate').safeParse({
      critiques: [{ target_title: 'T', stance: 'ATTACK', comment: 'C' }],
    });
    expect(stance.success).toBe(true);
    if (stance.success) {
      expect(stance.data).toEqual({
        critiques: [{ target_title: 'T', stance: 'attack', comment: 'C' }],
      });
    }

    expect(schemaForStep('refine').safeParse({ refined: 42 }).success).toBe(true);
    expect(schemaForStep('propose').safeParse(undefined).success).toBe(false);
  });
});

describe('settings coercion matrix', () => {
  it('keeps valid values and drops malformed ones per field', () => {
    const db = getDb();
    const good = putSettings(db, {
      theme: 'hearth',
      budgetUsd: 2,
      maxTokens: 5000,
      maxCalls: 20,
      staggerCadenceMs: 0,
      refineEnabled: false,
      maxCritiquesPerAgent: 5,
      reasoningPanelEnabled: false,
      defaultAvatarStyle: 'lucide',
      temperatureBySeatClass: { me: 0.3, lens: 0.9 },
      requestTimeoutMs: 5000,
      retries: 0,
      concurrency: 4,
    });
    expect(good.theme).toBe('hearth');
    expect(good.temperatureBySeatClass).toEqual({ me: 0.3, lens: 0.9 });

    const before = getSettingsOrDefaults(db);
    const after = putSettings(db, {
      theme: 'nope',
      budgetUsd: -1,
      maxTokens: 0,
      maxCalls: NaN,
      staggerCadenceMs: -5,
      refineEnabled: 'yes',
      maxCritiquesPerAgent: -1,
      reasoningPanelEnabled: 1,
      defaultAvatarStyle: 'photographic',
      temperatureBySeatClass: { me: 'hot' },
      requestTimeoutMs: 0,
      retries: -2,
      concurrency: 0,
    } as unknown as Parameters<typeof putSettings>[1]);
    // Nothing malformed survived; the stored good values stand.
    expect(after).toEqual(before);
  });
});

describe('hash edges', () => {
  it('handles circular, null and empty inputs without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(canonicalJson(circular)).toBe('"[unserialisable]"');
    expect(canonicalJson(undefined)).toBe('');
    expect(computeSourceHash({})).toBe(computeSourceHash({}));
    expect(isEmptySourceHash(computeSourceHash({}))).toBe(true);
    expect(isEmptySourceHash(null)).toBe(true);
    expect(isEmptySourceHash('abc')).toBe(false);
    const h = computeSourceHash({ github: 'x' });
    expect(sourceHashMatches(h, h)).toBe(true);
    expect(sourceHashMatches(h, `${h}x`)).toBe(false);
    expect(sourceHashMatches(null, h)).toBe(false);
    expect(sourceHashMatches(h, null)).toBe(false);
    expect(shortHash('abcdef', 3)).toBe('abc');
    expect(shortHash('ab')).toBe('ab');
  });
});

function fakeCtx(): RunContext {
  const snapshot = [
    { id: 'me', seatKey: 'seat_me', name: 'You', isMeAgent: true, lensPrompt: '', provider: 'mock', modelId: 'mock', temperature: 0.5, rawWeight: 0.25, normalisedWeight: 0.5, accentColor: '#fff', accentToken: '--seat-1', orderIndex: 0, enabled: true },
    { id: 'lens', seatKey: 'seat_wildcard', name: 'Wildcard', isMeAgent: false, lensPrompt: '', provider: 'mock', modelId: 'mock', temperature: 0.7, rawWeight: 0.25, normalisedWeight: 0.5, accentColor: '#fff', accentToken: '--seat-3', orderIndex: 1, enabled: true },
    { id: 'off', seatKey: 'seat_x', name: 'Off', isMeAgent: false, lensPrompt: '', provider: 'mock', modelId: 'mock', temperature: 0.7, rawWeight: 9, normalisedWeight: 0, accentColor: '#fff', accentToken: '--seat-2', orderIndex: 2, enabled: false },
  ];
  return {
    snapshot,
    normalisedWeights: { me: 0.5, lens: 0.5 },
    proposals: [
      { id: 'p1', runId: 'r', agentId: 'ghost', round: 1, title: 'Orphan', description: 'No author seat.', rationale: '', feasibilityWeeks: null, parentProposalId: null, status: 'active', createdAt: 3 },
      { id: 'p2', runId: 'r', agentId: 'me', round: 1, title: 'Mine', description: 'Mine.', rationale: '', feasibilityWeeks: null, parentProposalId: null, status: 'active', createdAt: 1 },
      { id: 'p3', runId: 'r', agentId: 'lens', round: 1, title: 'Gone', description: 'Merged away.', rationale: '', feasibilityWeeks: null, parentProposalId: 'p2', status: 'merged', createdAt: 2 },
    ],
    votes: [
      { id: 'v1', runId: 'r', agentId: 'me', proposalId: 'p1', score: 6, weightAtVote: 0.5, weightedScore: 3, comment: 'ok', createdAt: 1 },
      { id: 'v2', runId: 'r', agentId: 'lens', proposalId: 'p1', score: 6, weightAtVote: 0.5, weightedScore: 3, comment: 'ok', createdAt: 1 },
      { id: 'v3', runId: 'r', agentId: 'me', proposalId: 'p2', score: 9, weightAtVote: 0.5, weightedScore: 4.5, comment: 'mine', createdAt: 1 },
    ],
  } as unknown as RunContext;
}

describe('scoreboard with ragged inputs', () => {
  it('falls back for unknown authors, skips merged proposals and non-voters', () => {
    const board = buildScoreboard(fakeCtx());
    // Merged proposal excluded; two active rows, highest first.
    expect(board.map((r) => r.proposalId)).toEqual(['p2', 'p1']);
    expect(board[0]!.rank).toBe(0);
    expect(board[1]!.rank).toBe(1);
    // Unknown author: truncated id as name, default accent.
    expect(board[1]!.authorName).toBe('ghost'.slice(0, 8));
    expect(board[1]!.leadAccent).toBe('--seat-1');
    // No contrarian or Me-Agent vote on p1's row shape: meScore present where voted.
    expect(board[0]!.meScore).toBe(9);
    expect(board[0]!.contrarianScore).toBeNull();
    // The lens seat did not vote on p2: no per-seat row for a non-vote.
    expect(board[0]!.perSeat.map((s) => s.agentId)).toEqual(['me']);
    expect(board[0]!.voteCount).toBe(1);
  });

  it('renders partial scores and handles an empty table', () => {
    const partials = partialScoresFrom(fakeCtx());
    expect(partials).toHaveLength(2);
    expect(partials[0]).toMatchObject({ proposalId: 'p2', votesCast: 1 });
    const empty = fakeCtx();
    (empty as { proposals: unknown[] }).proposals = [];
    expect(buildScoreboard(empty)).toEqual([]);
    expect(partialScoresFrom(empty)).toEqual([]);
  });
});
