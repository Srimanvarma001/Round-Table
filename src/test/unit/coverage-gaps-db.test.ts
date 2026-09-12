import './env';

import { beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../scripts/migrate';
import { getDb, newId, nowMs, REQUIRED_TABLES, tablesExist } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { getProposal, listProposals, updateProposalStatus } from '@/lib/db/queries/artifacts';
import { appendEvent, getEvent, lastEventId, listEventsAfterId } from '@/lib/db/queries/events';
import { getMessage, insertMessage, listMessages } from '@/lib/db/queries/messages';
import {
  activateProfile,
  clearIngestRuns,
  finishIngestRun,
  listIngestRuns,
  listProfileItems,
  markProfileItemsStale,
} from '@/lib/db/queries/profile';
import { countRuns, createRun, listRuns } from '@/lib/db/queries/runs';
import { loadPricingRows } from '@/lib/orchestrator/budget';
import type { AgentSnapshotEntry } from '@/shared/types';

/**
 * DB-backed branch-coverage gap closers: miss paths, clamps, filters and
 * fallbacks in the query helpers and the pricing loader. Shares the per-file
 * temporary database from `./env` (never the developer's real database).
 */

const USER = 'gap-user';
const SNAPSHOT: AgentSnapshotEntry[] = [];
const CONFIG = {
  budgetUsd: 10,
  maxTokens: 1000,
  maxCalls: 100,
  staggerCadenceMs: 0,
  refineEnabled: true,
  searchEnabled: false,
};

function makeRun(seedPrompt: string) {
  return createRun(getDb(), {
    userId: USER,
    seedPrompt,
    seedMode: 'specific',
    status: 'created',
    currentStep: 'propose',
    stepIndex: 0,
    round: 1,
    agentSnapshot: SNAPSHOT,
    configSnapshot: CONFIG,
    profileId: null,
    tokensIn: 0,
    tokensOut: 0,
    costEstimateUsd: 0,
    llmCalls: 0,
    pauseRequested: false,
  });
}

beforeAll(() => {
  runMigrations();
  getDb().insert(users).values({ id: USER, displayName: 'Gap', createdAt: Date.now() }).run();
});

describe('db client', () => {
  it('exposes table inventory and id helpers', () => {
    expect(REQUIRED_TABLES).toHaveLength(12);
    expect(tablesExist()).toBe(true);
    expect(typeof nowMs()).toBe('number');
    expect(newId()).not.toBe(newId());
  });
});

describe('artifact misses and filters', () => {
  it('returns undefined for missing rows and filters empty lists', () => {
    const db = getDb();
    const run = makeRun('gap artifacts');
    expect(getProposal(db, 'missing')).toBeUndefined();
    expect(updateProposalStatus(db, 'missing', 'merged')).toBeUndefined();
    expect(listProposals(db, run.id, { round: 1, status: 'active' })).toEqual([]);
  });
});

describe('event paging edges', () => {
  it('clamps page sizes and reports empty runs', () => {
    const db = getDb();
    const run = makeRun('gap events');
    appendEvent(db, { runId: run.id, type: 'run.started', payload: { steps: [] } });
    appendEvent(db, { runId: run.id, type: 'agent.delta', payload: {}, agentId: 'a', step: 'propose' });
    expect(listEventsAfterId(db, run.id, 0, 99999)).toHaveLength(2);
    expect(listEventsAfterId(db, run.id, 0, 0)).toHaveLength(1);
    expect(getEvent(db, -1)).toBeUndefined();
    expect(lastEventId(db, 'no-such-run')).toBe(0);
  });
});

describe('message uniqueness and filters', () => {
  it('throws on duplicate task keys and filters by seat and step', () => {
    const db = getDb();
    const run = makeRun('gap messages');
    const key = `run:${run.id}:step:propose:agent:x:round:1:attempt-agnostic`;
    const row = {
      runId: run.id,
      agentId: 'x',
      step: 'propose',
      taskKey: key,
      requestJson: {},
      reasoningText: '',
      contentText: 'hi',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      latencyMs: 1,
      finishReason: 'stop',
      error: null,
    };
    insertMessage(db, row);
    expect(() => insertMessage(db, row)).toThrow();
    expect(getMessage(db, run.id, 'x', 'propose')?.contentText).toBe('hi');
    expect(getMessage(db, run.id, 'nobody', 'propose')).toBeUndefined();
    expect(listMessages(db, run.id, { step: 'propose', agentId: 'x' })).toHaveLength(1);
    expect(listMessages(db, run.id, { step: 'vote' })).toEqual([]);
  });
});

describe('profile misses and ingest-run bookkeeping', () => {
  it('handles missing profiles and empty ingest history', () => {
    const db = getDb();
    expect(activateProfile(db, 'missing')).toBeUndefined();
    expect(markProfileItemsStale(db, 'missing', [])).toBe(0);
    expect(listProfileItems(db, 'missing', { kind: 'skill', source: 'github', includeStale: true })).toEqual([]);
    expect(finishIngestRun(db, 'missing', {})).toBeUndefined();
    expect(listIngestRuns(db, 0)).toEqual([]);
    clearIngestRuns(db);
    expect(listIngestRuns(db)).toEqual([]);
  });
});

describe('run listing clamps', () => {
  it('clamps limits and filters by seed and status', () => {
    const db = getDb();
    const run = makeRun('gap-zzz-unique seed');
    expect(listRuns(db, { limit: 0 }).length).toBeLessThanOrEqual(1);
    expect(listRuns(db, { limit: 99999 }).length).toBeGreaterThanOrEqual(1);
    expect(listRuns(db, { seedContains: 'gap-zzz-unique' }).map((r) => r.id)).toContain(run.id);
    expect(countRuns(db, { status: 'created' })).toBeGreaterThanOrEqual(1);
  });
});

describe('pricing loader fallback', () => {
  it('returns a usable table', () => {
    const rows = loadPricingRows();
    expect(Array.isArray(rows)).toBe(true);
  });
});
