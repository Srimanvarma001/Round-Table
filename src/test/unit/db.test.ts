import './env';

import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../scripts/migrate';
import { DEFAULT_SEATS } from '@/lib/agents/defaults';
import { getDb } from '@/lib/db/client';
import {
  createAgent,
  deleteAgent,
  ensureUniqueMeAgent,
  getAgent,
  getAgentBySeatKey,
  getMeAgent,
  listAgents,
  setAgentAvatarCache,
  updateAgent,
} from '@/lib/db/queries/agents';
import {
  insertCritique,
  insertProposal,
  insertVote,
  listCritiques,
  listProposals,
  listVotes,
  upsertVote,
} from '@/lib/db/queries/artifacts';
import { appendEvent, lastEventId, listEvents, nextSeq } from '@/lib/db/queries/events';
import {
  getMessageByTaskKey,
  insertMessageIfNew,
  listMessages,
  taskExists,
} from '@/lib/db/queries/messages';
import {
  getPricing,
  listPricing,
  pricingUpdatedAt,
  upsertPricing,
  upsertPricingMany,
} from '@/lib/db/queries/pricing';
import {
  activateProfile,
  appendIngestRun,
  archiveProfile,
  createProfile,
  deleteProfileItem,
  finishIngestRun,
  getActiveProfile,
  getProfileItem,
  insertProfileItem,
  listIngestRuns,
  listProfileItems,
  listProfiles,
  markItemsMissingFromExtraction,
  nextProfileVersion,
  updateProfile,
  updateProfileItem,
} from '@/lib/db/queries/profile';
import {
  bumpRunUsage,
  countRuns,
  createRun,
  deleteRun,
  getRun,
  listRuns,
  setRunStep,
  sweepStaleRuns,
  updateRun,
} from '@/lib/db/queries/runs';
import {
  deleteSetting,
  getSetting,
  getSettingOrDefault,
  getSettingsOrDefaults,
  listSettings,
  putSettings,
  setSetting,
} from '@/lib/db/queries/settings';
import { users } from '@/lib/db/schema';
import type { AgentSnapshotEntry } from '@/shared/types';

/**
 * Typed query helpers, sections 7 and 14, against a temporary database.
 *
 * Every table group: insert, read, update, list/filter, delete, and the one
 * invariant each module exists to enforce (unique Me Agent, snapshot
 * immutability inputs, single active profile, task-key uniqueness).
 */

const USER = 'unit-user';

function seedUser() {
  const db = getDb();
  db.insert(users).values({ id: USER, displayName: 'Unit', createdAt: Date.now() }).run();
}

function seedAgents() {
  const db = getDb();
  for (const seat of DEFAULT_SEATS) {
    createAgent(db, {
      userId: USER,
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
}

const SNAPSHOT: AgentSnapshotEntry[] = [];
const CONFIG = {
  budgetUsd: 10,
  maxTokens: 1000,
  maxCalls: 100,
  staggerCadenceMs: 0,
  refineEnabled: true,
  searchEnabled: false,
};

function makeRun(seedPrompt = 'unit seed') {
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
  seedUser();
  seedAgents();
});

describe('agents', () => {
  it('seeds eight seats with exactly one Me Agent', () => {
    const db = getDb();
    expect(listAgents(db)).toHaveLength(8);
    expect(getMeAgent(db)?.seatKey).toBe('seat_me');
  });

  it('reads back by id and seat key, and updates name and weight', () => {
    const db = getDb();
    const me = getMeAgent(db)!;
    expect(getAgent(db, me.id)?.id).toBe(me.id);
    expect(getAgentBySeatKey(db, 'seat_me')?.id).toBe(me.id);
    const updated = updateAgent(db, me.id, { name: 'Renamed', weight: 0.3 });
    expect(updated?.name).toBe('Renamed');
    expect(updated?.weight).toBeCloseTo(0.3, 12);
    updateAgent(db, me.id, { name: 'You', weight: 0.25 });
  });

  it('keeps the Me Agent flag unique', () => {
    const db = getDb();
    const other = getAgentBySeatKey(db, 'seat_pragmatist')!;
    updateAgent(db, other.id, { isMeAgent: true });
    expect(ensureUniqueMeAgent(db, other.id)).toBeGreaterThanOrEqual(1);
    expect(getMeAgent(db)?.id).toBe(other.id);
    const me = getAgentBySeatKey(db, 'seat_me')!;
    updateAgent(db, me.id, { isMeAgent: true });
    ensureUniqueMeAgent(db, me.id);
    expect(getMeAgent(db)?.id).toBe(me.id);
  });

  it('refuses to delete the Me Agent, deletes ordinary seats, 404s unknown ids', () => {
    const db = getDb();
    const me = getMeAgent(db)!;
    expect(deleteAgent(db, me.id)).toEqual({ deleted: false, id: me.id, reason: 'me_agent' });
    expect(deleteAgent(db, 'no-such-seat')).toEqual({
      deleted: false,
      id: 'no-such-seat',
      reason: 'not_found',
    });
    const wild = getAgentBySeatKey(db, 'seat_wildcard')!;
    expect(deleteAgent(db, wild.id).deleted).toBe(true);
    expect(getAgent(db, wild.id)).toBeUndefined();
    // Restore the deleted seat for the other suites in this file.
    const seat = DEFAULT_SEATS.find((s) => s.seatKey === 'seat_wildcard')!;
    createAgent(db, {
      userId: USER,
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
  });

  it('caches and clears avatar SVG', () => {
    const db = getDb();
    const me = getMeAgent(db)!;
    expect(setAgentAvatarCache(db, me.id, '<svg/>')?.avatarSvgCache).toBe('<svg/>');
    expect(setAgentAvatarCache(db, me.id, null)?.avatarSvgCache).toBeNull();
  });
});

describe('runs', () => {
  it('creates, reads, lists newest-first, filters and counts', () => {
    const db = getDb();
    const a = makeRun('alpha seed');
    const b = makeRun('beta seed');
    expect(getRun(db, a.id)?.seedPrompt).toBe('alpha seed');
    const listed = listRuns(db, { userId: USER });
    expect(listed[0]!.createdAt).toBeGreaterThanOrEqual(listed[listed.length - 1]!.createdAt);
    expect(listRuns(db, { seedContains: 'alpha' }).map((r) => r.id)).toContain(a.id);
    // SQLite LIKE is ASCII case-insensitive, so the uppercase query matches too.
    expect(listRuns(db, { seedContains: 'ALPHA' }).map((r) => r.id)).toContain(a.id);
    expect(listRuns(db, { status: 'created' }).length).toBeGreaterThanOrEqual(2);
    expect(countRuns(db, { userId: USER })).toBeGreaterThanOrEqual(2);
    expect(getRun(db, b.id)).toBeDefined();
  });

  it('updates, bumps usage in SQL, advances steps and deletes with cascades', () => {
    const db = getDb();
    const run = makeRun('usage seed');
    updateRun(db, run.id, { status: 'running' });
    bumpRunUsage(db, run.id, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, llmCalls: 2 });
    const after = getRun(db, run.id)!;
    expect(after.tokensIn).toBe(100);
    expect(after.tokensOut).toBe(50);
    expect(after.llmCalls).toBe(2);
    setRunStep(db, run.id, 'vote', 3);
    expect(getRun(db, run.id)?.currentStep).toBe('vote');
    expect(deleteRun(db, run.id)).toBe(true);
    expect(getRun(db, run.id)).toBeUndefined();
    expect(deleteRun(db, run.id)).toBe(false);
  });

  it('sweeps running rows on boot and leaves paused rows alone', () => {
    const db = getDb();
    const flying = makeRun('flying seed');
    const waiting = makeRun('waiting seed');
    updateRun(db, flying.id, { status: 'running' });
    updateRun(db, waiting.id, { status: 'paused' });
    expect(sweepStaleRuns(db)).toBeGreaterThanOrEqual(1);
    expect(getRun(db, flying.id)?.status).toBe('failed');
    expect(getRun(db, flying.id)?.errorCode).toBe('PROCESS_RESTART');
    expect(getRun(db, waiting.id)?.status).toBe('paused');
  });
});

describe('artifacts', () => {
  it('stores proposals, critiques and votes with filters', () => {
    const db = getDb();
    const run = makeRun('artifact seed');
    const agents = listAgents(db);
    const prop = insertProposal(db, {
      runId: run.id,
      agentId: agents[0]!.id,
      round: 1,
      title: 'Sprout Log',
      description: 'A watering log.',
      rationale: 'Small.',
    });
    expect(listProposals(db, run.id)).toHaveLength(1);
    insertCritique(db, {
      runId: run.id,
      agentId: agents[1]!.id,
      targetProposalId: prop.id,
      stance: 'attack',
      comment: 'Too small.',
      round: 1,
    });
    expect(listCritiques(db, run.id)).toHaveLength(1);
    insertVote(db, {
      runId: run.id,
      agentId: agents[0]!.id,
      proposalId: prop.id,
      score: 8,
      weightAtVote: 0.25,
      weightedScore: 2,
      comment: 'Good.',
    });
    expect(listVotes(db, run.id)).toHaveLength(1);
    // Upsert replaces the same seat's vote rather than doubling it.
    upsertVote(db, {
      runId: run.id,
      agentId: agents[0]!.id,
      proposalId: prop.id,
      score: 9,
      weightAtVote: 0.25,
      weightedScore: 2.25,
      comment: 'Better.',
    });
    expect(listVotes(db, run.id)).toHaveLength(1);
    expect(listVotes(db, run.id)[0]!.score).toBe(9);
  });
});

describe('events and messages', () => {
  it('appends gapless seq numbers and pages after a seq', () => {
    const db = getDb();
    const run = makeRun('event seed');
    appendEvent(db, { runId: run.id, type: 'run.started', payload: { steps: [] } });
    appendEvent(db, { runId: run.id, type: 'step.started', payload: {}, step: 'propose' });
    expect(nextSeq(db, run.id)).toBe(3);
    expect(listEvents(db, run.id).map((e) => e.seq)).toEqual([1, 2]);
    expect(listEvents(db, run.id, 1).map((e) => e.seq)).toEqual([2]);
    expect(lastEventId(db, run.id)).toBeGreaterThan(0);
  });

  it('enforces task-key uniqueness for idempotent resume', () => {
    const db = getDb();
    const run = makeRun('message seed');
    const key = `run:${run.id}:step:propose:agent:x:round:1:attempt-agnostic`;
    expect(taskExists(db, key)).toBe(false);
    insertMessageIfNew(db, {
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
    });
    expect(taskExists(db, key)).toBe(true);
    // Second insert is a no-op through the unique index.
    insertMessageIfNew(db, {
      runId: run.id,
      agentId: 'x',
      step: 'propose',
      taskKey: key,
      requestJson: {},
      reasoningText: '',
      contentText: 'hi again',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      latencyMs: 1,
      finishReason: 'stop',
      error: null,
    });
    expect(listMessages(db, run.id)).toHaveLength(1);
    expect(getMessageByTaskKey(db, key)?.contentText).toBe('hi');
  });
});

describe('profiles and items', () => {
  it('keeps exactly one active profile and versions upward', () => {
    const db = getDb();
    expect(nextProfileVersion(db)).toBe(1);
    const v1 = createProfile(db, {
      userId: USER,
      version: 1,
      status: 'active',
      summaryText: 'one',
      authorBrief: 'one',
      sourceHash: 'a',
      generatedAt: Date.now(),
      lastManualEditAt: null,
    });
    expect(getActiveProfile(db)?.id).toBe(v1.id);
    const v2 = createProfile(db, {
      userId: USER,
      version: 2,
      status: 'draft',
      summaryText: 'two',
      authorBrief: 'two',
      sourceHash: 'b',
      generatedAt: Date.now(),
      lastManualEditAt: null,
    });
    expect(listProfiles(db)[0]!.version).toBe(2);
    const activated = activateProfile(db, v2.id);
    expect(activated?.status).toBe('active');
    expect(getActiveProfile(db)?.id).toBe(v2.id);
    archiveProfile(db, v2.id);
    expect(getActiveProfile(db)).toBeUndefined();
    activateProfile(db, v2.id);
    updateProfile(db, v2.id, { summaryText: 'edited' });
    expect(getActiveProfile(db)?.summaryText).toBe('edited');
  });

  it('cruds items and hides missing-from-extraction generated rows', () => {
    const db = getDb();
    const profile = getActiveProfile(db)!;
    const item = insertProfileItem(db, {
      profileId: profile.id,
      kind: 'skill',
      label: 'TypeScript',
      detail: 'Production.',
      source: 'github',
      confidence: 0.9,
      locked: false,
      stale: false,
      orderIndex: 1,
    });
    expect(getProfileItem(db, item.id)?.label).toBe('TypeScript');
    expect(listProfileItems(db, profile.id)).toHaveLength(1);
    updateProfileItem(db, item.id, { detail: 'A decade.' });
    expect(getProfileItem(db, item.id)?.detail).toBe('A decade.');
    // keepIds carries surviving extraction ids: a kept row stays fresh, an
    // absent generated row goes stale (hidden, never deleted).
    markItemsMissingFromExtraction(db, profile.id, [item.id]);
    expect(getProfileItem(db, item.id)?.stale).toBe(false);
    markItemsMissingFromExtraction(db, profile.id, []);
    expect(getProfileItem(db, item.id)?.stale).toBe(true);
    expect(deleteProfileItem(db, item.id)).toBe(true);
    expect(getProfileItem(db, item.id)).toBeUndefined();
  });

  it('records ingest runs with errors visible rather than silent', () => {
    const db = getDb();
    const started = appendIngestRun(db, { source: 'github', startedAt: Date.now() });
    finishIngestRun(db, started.id, {
      finishedAt: Date.now(),
      itemCount: 3,
      error: 'rate limited',
    });
    const runs = listIngestRuns(db);
    expect(runs[0]?.error).toBe('rate limited');
    expect(runs[0]?.itemCount).toBe(3);
  });
});

describe('settings and pricing', () => {
  it('serves defaults, coerces stored rows and drops malformed ones', () => {
    const db = getDb();
    const defaults = getSettingsOrDefaults(db);
    expect(defaults.theme).toBe('warroom');
    expect(getSetting(db, 'theme')).toBeUndefined();
    expect(getSettingOrDefault(db, 'theme', 'hearth')).toBe('hearth');
    setSetting(db, 'theme', 'hearth');
    expect(getSettingsOrDefaults(db).theme).toBe('hearth');
    // A hand-edited wrong-typed row is dropped, not fatal.
    setSetting(db, 'budgetUsd', 'a lot');
    expect(getSettingsOrDefaults(db).budgetUsd).toBe(defaults.budgetUsd);
    expect(listSettings(db).length).toBeGreaterThan(0);
    const merged = putSettings(db, { staggerCadenceMs: 0, refineEnabled: false });
    expect(merged.staggerCadenceMs).toBe(0);
    expect(merged.refineEnabled).toBe(false);
    expect(deleteSetting(db, 'theme')).toBe(true);
    expect(deleteSetting(db, 'theme')).toBe(false);
  });

  it('upserts pricing and reports the last-checked date', () => {
    const db = getDb();
    expect(pricingUpdatedAt(db)).toBeNull();
    upsertPricing(db, {
      provider: 'glm',
      modelId: 'glm-5.3-flash',
      inputPerMtokUsd: 0.1,
      outputPerMtokUsd: 0.3,
    });
    expect(getPricing(db, 'glm', 'glm-5.3-flash')?.outputPerMtokUsd).toBe(0.3);
    expect(upsertPricingMany(db, [])).toBe(0);
    expect(listPricing(db)).toHaveLength(1);
    expect(pricingUpdatedAt(db)).not.toBeNull();
  });
});
