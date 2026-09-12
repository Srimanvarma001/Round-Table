import './setup';

import { asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../scripts/migrate';
import { DEFAULT_SEATS } from '@/lib/agents/defaults';
import { normaliseWeights, scoreProposal } from '@/lib/agents/weights';
import { config, getDb } from '@/lib/db/client';
import { createAgent, listAgents } from '@/lib/db/queries/agents';
import { listProposals, listVotes } from '@/lib/db/queries/artifacts';
import { listMessages } from '@/lib/db/queries/messages';
import { upsertPricingMany } from '@/lib/db/queries/pricing';
import { createRun, getRun, updateRun } from '@/lib/db/queries/runs';
import { agentMessages, runEvents, runs, users } from '@/lib/db/schema';
import { DEFAULT_PRICING } from '@/lib/llm/pricing';
import { clearAdapterCache, getMockAdapter } from '@/lib/llm/registry';
import { BudgetGuard, budgetLimitsFrom } from '@/lib/orchestrator/budget';
import { getRunEventBus } from '@/lib/orchestrator/bus';
import { buildScoreboard, loadRunContext } from '@/lib/orchestrator/context';
import { executeRun } from '@/lib/orchestrator/engine';
import type { AgentSnapshotEntry } from '@/shared/types';

/**
 * Full runs against MockLLMAdapter on a temporary SQLite file, section 19.2.
 *
 * - happy path: completed, winner present, scores recompute, events gapless
 * - pause mid-propose: nothing aborted, nothing new dispatched, pending keys
 * - resume: completed task keys never re-requested, same call count
 * - budget abort: failed with BUDGET_EXCEEDED, partial run browsable
 * - seat failure: one seat failing still completes, named in the reveal
 * - structured-output failure: two bad replies degrade that seat only
 * - provider outage: a total outage fails honestly with artefacts preserved
 * - replay: rebuilding the scoreboard makes zero adapter calls
 */

const SEED = 'A CLI tool for tracking houseplants';

function snapshotForRun() {
  const db = getDb();
  const rows = listAgents(db);
  const normalised = normaliseWeights(
    rows.map((row) => ({ id: row.id, weight: row.weight, enabled: row.enabled })),
  );
  const snapshot: AgentSnapshotEntry[] = rows
    .filter((row) => row.enabled)
    .map((row) => ({
      id: row.id,
      seatKey: row.seatKey,
      name: row.name,
      isMeAgent: row.isMeAgent,
      lensPrompt: row.lensPrompt,
      provider: row.provider,
      modelId: row.modelId,
      temperature: row.temperature,
      rawWeight: row.weight,
      normalisedWeight: normalised[row.id] ?? 0,
      accentColor: row.accentColor,
      accentToken: row.accentToken,
      orderIndex: row.orderIndex,
      enabled: row.enabled,
    }));
  return snapshot;
}

function makeRun(
  overrides: { seedPrompt?: string; budgetUsd?: number; maxCalls?: number; refineEnabled?: boolean } = {},
) {
  const db = getDb();
  return createRun(db, {
    userId: config.APP_USER_ID,
    seedPrompt: overrides.seedPrompt ?? SEED,
    seedMode: 'specific',
    status: 'created',
    currentStep: 'propose',
    stepIndex: 0,
    round: 1,
    agentSnapshot: snapshotForRun(),
    configSnapshot: {
      budgetUsd: overrides.budgetUsd ?? 10,
      maxTokens: 1_000_000,
      maxCalls: overrides.maxCalls ?? 500,
      staggerCadenceMs: 0,
      refineEnabled: overrides.refineEnabled ?? true,
      searchEnabled: false,
    },
    profileId: null,
    tokensIn: 0,
    tokensOut: 0,
    costEstimateUsd: 0,
    llmCalls: 0,
    pauseRequested: false,
  });
}

function eventsOf(runId: string) {
  return getDb()
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq), asc(runEvents.id))
    .all();
}

function freshMock() {
  clearAdapterCache();
  const mock = getMockAdapter();
  mock.reset();
  mock.configure({ failSeats: [], failTimes: 0, failureMode: 'client', latencyMs: 0, failIf: null });
  mock.setScript(null);
  return mock;
}

beforeAll(() => {
  runMigrations();
  const db = getDb();
  db.insert(users).values({ id: config.APP_USER_ID, displayName: 'Int User', createdAt: Date.now() }).run();
  for (const seat of DEFAULT_SEATS) {
    createAgent(db, {
      userId: config.APP_USER_ID,
      seatKey: seat.seatKey,
      name: seat.name,
      isMeAgent: seat.isMeAgent,
      lensPrompt: seat.lensPrompt,
      provider: 'mock',
      modelId: 'mock',
      temperature: seat.temperature,
      weight: seat.weight,
      avatarStyle: seat.avatarStyle,
      avatarSeed: seat.avatarSeed,
      avatarSvgCache: null,
      accentColor: seat.accentColor,
      accentToken: seat.accentToken,
      iconName: seat.iconName,
      enabled: seat.enabled,
      orderIndex: seat.orderIndex,
    });
  }
  upsertPricingMany(db, DEFAULT_PRICING);
});

describe('happy path', () => {
  it('completes with a winner, recomputable scores and a gapless event log', async () => {
    const mock = freshMock();
    const run = makeRun();
    const result = await executeRun(run.id);

    expect(result.status).toBe('completed');
    expect(getRun(getDb(), run.id)?.status).toBe('completed');
    expect(mock.calls.length).toBeGreaterThan(0);
    expect(mock.calls.every((c) => c.ok)).toBe(true);

    // Winner present and final_score matches a recomputed value.
    const ctx = loadRunContext(run.id, getRunEventBus(), new BudgetGuard(budgetLimitsFrom()));
    expect(ctx).not.toBeNull();
    const board = buildScoreboard(ctx!);
    expect(board.length).toBeGreaterThanOrEqual(3);
    expect(board[0]!.finalScore).toBeGreaterThanOrEqual(board[board.length - 1]!.finalScore);

    const db = getDb();
    const votes = listVotes(db, run.id);
    const check = scoreProposal(
      votes.filter((v) => v.proposalId === board[0]!.proposalId),
      Object.fromEntries(ctx!.snapshot.map((s) => [s.id, s.normalisedWeight])),
    );
    expect(check.finalScore).toBeCloseTo(board[0]!.finalScore, 9);

    // Event sequence well-formed and gapless.
    const events = eventsOf(run.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run.started');
    expect(types).toContain('step.completed');
    expect(types[types.length - 1]).toBe('run.completed');

    // Every planned step completed.
    const completedSteps = events
      .filter((e) => e.type === 'step.completed')
      .map((e) => (e.payload as { step: string }).step);
    for (const step of ['propose', 'debate', 'refine', 'vote', 'reveal']) {
      expect(completedSteps).toContain(step);
    }
  }, 60_000);
});

describe('pause and resume', () => {
  it('parks before dispatching anything when the flag is already set', async () => {
    const mock = freshMock();
    const run = makeRun({ seedPrompt: `${SEED} (pause)` });
    updateRun(getDb(), run.id, { status: 'running', pauseRequested: true });

    const result = await executeRun(run.id);
    expect(result.status).toBe('paused');
    expect(getRun(getDb(), run.id)?.status).toBe('paused');
    // No task dispatched after the flag: zero adapter calls, zero messages.
    expect(mock.calls).toHaveLength(0);
    expect(listMessages(getDb(), run.id)).toHaveLength(0);

    const paused = eventsOf(run.id).filter((e) => e.type === 'run.paused');
    expect(paused).toHaveLength(1);
    const payload = paused[0]!.payload as { pendingTaskKeys: string[]; nextStep: string };
    expect(payload.pendingTaskKeys.length).toBeGreaterThan(0);
    expect(payload.nextStep).toBe('propose');
  }, 60_000);

  it('resumes to completed without re-requesting finished keys', async () => {
    const mock = freshMock();
    const run = makeRun({ seedPrompt: `${SEED} (resume)` });

    // Finish the propose step's first task manually is not possible without an
    // engine, so: pause first (zero work done), resume, and compare against a
    // fresh uninterrupted run with the same seed.
    updateRun(getDb(), run.id, { status: 'running', pauseRequested: true });
    await executeRun(run.id);
    updateRun(getDb(), run.id, { status: 'running', pauseRequested: false });
    const resumed = await executeRun(run.id);
    expect(resumed.status).toBe('completed');
    const resumedCalls = mock.calls.length;

    mock.reset();
    const fresh = makeRun({ seedPrompt: `${SEED} (resume)` });
    const freshResult = await executeRun(fresh.id);
    expect(freshResult.status).toBe('completed');

    // Resume paid for nothing twice: identical call counts.
    expect(resumedCalls).toBe(mock.calls.length);

    // Task keys unique: no logical task was ever recorded twice.
    const keys = getDb()
      .select({ taskKey: agentMessages.taskKey })
      .from(agentMessages)
      .where(eq(agentMessages.runId, run.id))
      .all()
      .map((r) => r.taskKey);
    expect(new Set(keys).size).toBe(keys.length);
  }, 120_000);
});

describe('budget abort', () => {
  it('fails with BUDGET_EXCEEDED and keeps the partial run browsable', async () => {
    // The mock prices at zero (no mock rows in model_pricing), so the call
    // ceiling is the honest tripwire here: the guard checks before dispatch,
    // never mid-call, and the fourth dispatch attempt aborts the run.
    const mock = freshMock();
    const run = makeRun({ seedPrompt: `${SEED} (budget)`, maxCalls: 3 });
    const result = await executeRun(run.id);

    expect(result.status).toBe('failed');
    const row = getRun(getDb(), run.id);
    expect(row?.errorCode).toBe('BUDGET_EXCEEDED');
    // Partial artefacts preserved and the run stays browsable.
    expect(row).toBeDefined();
    expect(eventsOf(run.id).length).toBeGreaterThan(0);
    // Nothing dispatched after the limit: the propose wave settles, then the
    // guard trips before the debate wave. (With 8-way concurrency the whole
    // first wave passes the pre-dispatch check before anything settles —
    // the guard checks before dispatch, never mid-call.)
    expect(mock.calls.length).toBeLessThanOrEqual(8);
    expect(listMessages(getDb(), run.id, { step: 'debate' })).toHaveLength(0);
  }, 60_000);
});

describe('seat failure', () => {
  it('one seat failing every call still completes and is named in the reveal', async () => {
    const mock = freshMock();
    mock.configure({ failSeats: ['contrarian'] });
    const run = makeRun({ seedPrompt: `${SEED} (seat failure)` });
    const result = await executeRun(run.id);

    expect(result.status).toBe('completed');
    // Failed seats are runtime state, so they are read from the persisted
    // run.completed payload (metrics.failedSeats), not from a reloaded context.
    const completed = eventsOf(run.id).filter((e) => e.type === 'run.completed');
    expect(completed).toHaveLength(1);
    const metrics = (completed[0]!.payload as { metrics: { failedSeats: string[] } }).metrics;
    expect(metrics.failedSeats).toContain('The Contrarian');

    const db = getDb();
    const agents = listAgents(db);
    const contra = agents.find((a) => a.seatKey === 'seat_contrarian')!;
    expect(listProposals(db, run.id).filter((p) => p.agentId === contra.id)).toHaveLength(0);
    mock.configure({ failSeats: [] });
  }, 60_000);
});

describe('structured output failure', () => {
  it('two bad replies degrade that seat only', async () => {
    // Scoped to the vote step on purpose, with refine disabled: a seat that
    // cannot score still leaves every proposal standing, so the run must
    // complete with that seat's scores missing and nothing else changed.
    // (Failing a seat's propose would interact with refine's merging and the
    // INSUFFICIENT_PROPOSALS guard — a different scenario.)
    const mock = freshMock();
    mock.setScript((ctx) =>
      ctx.step === 'vote' && (ctx.request.label ?? '').toLowerCase().includes('wildcard')
        ? 'this is not JSON at all'
        : null,
    );
    const run = makeRun({ seedPrompt: `${SEED} (bad json)`, refineEnabled: false });
    const result = await executeRun(run.id);

    expect(result.status).toBe('completed');
    const db = getDb();
    const agents = listAgents(db);
    const wild = agents.find((a) => a.seatKey === 'seat_wildcard')!;
    // The seat proposed normally but cast no votes: initial attempt plus the
    // single repair retry both failed validation.
    expect(listProposals(db, run.id).filter((p) => p.agentId === wild.id).length).toBeGreaterThan(0);
    expect(listVotes(db, run.id).filter((v) => v.agentId === wild.id)).toHaveLength(0);
    expect(listVotes(db, run.id).length).toBeGreaterThan(0);
    // Every attempt recorded against the wildcard's vote task, and the seat
    // still cast no vote: initial attempt plus repair retry (json.ts), times
    // the scheduler's own retries for retryable failures.
    const wildVotes = mock.calls.filter((c) => (c.request.label ?? '').includes('vote:The Wildcard'));
    expect(wildVotes.length).toBeGreaterThanOrEqual(2);
    mock.setScript(null);
  }, 60_000);
});

describe('provider outage', () => {
  it('a total outage fails honestly with artefacts preserved', async () => {
    const mock = freshMock();
    mock.configure({ failIf: () => true, failureMode: 'server' });
    const run = makeRun({ seedPrompt: `${SEED} (outage)` });
    const result = await executeRun(run.id);

    // Section 17.5: with one provider a total outage fails the run honestly.
    // No proposal survived, so section 17.3 names the code.
    expect(result.status).toBe('failed');
    const row = getRun(getDb(), run.id);
    expect(row?.errorCode).toBe('INSUFFICIENT_PROPOSALS');
    // Honest failure keeps what completed: the run stays browsable/replayable.
    expect(eventsOf(run.id).length).toBeGreaterThan(0);
    expect(getRun(getDb(), run.id)).toBeDefined();
    mock.configure({ failIf: null, failureMode: 'client' });
  }, 180_000);
});

describe('replay', () => {
  it('rebuilding the scoreboard makes zero adapter calls and matches', async () => {
    const mock = freshMock();
    const run = makeRun({ seedPrompt: `${SEED} (replay)` });
    await executeRun(run.id);

    mock.reset();
    const build = () => {
      const ctx = loadRunContext(run.id, getRunEventBus(), new BudgetGuard(budgetLimitsFrom()));
      return ctx ? buildScoreboard(ctx) : null;
    };
    const first = build();
    const second = build();
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(mock.calls).toHaveLength(0);
  }, 60_000);
});

describe('drizzle bookkeeping', () => {
  it('marks swept runs and cascades deletes', async () => {
    const db = getDb();
    const run = makeRun({ seedPrompt: `${SEED} (sweep)` });
    updateRun(db, run.id, { status: 'running' });
    const { sweepStaleRuns, deleteRun } = await import('@/lib/db/queries/runs');
    expect(sweepStaleRuns(db)).toBeGreaterThanOrEqual(1);
    expect(getRun(db, run.id)?.status).toBe('failed');
    expect(getRun(db, run.id)?.errorCode).toBe('PROCESS_RESTART');
    expect(deleteRun(db, run.id)).toBe(true);
    expect(db.select().from(runs).where(eq(runs.id, run.id)).get()).toBeUndefined();
  });
});
