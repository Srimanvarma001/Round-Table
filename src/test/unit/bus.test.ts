import './env';

import { beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../scripts/migrate';
import { getDb } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { createRun } from '@/lib/db/queries/runs';
import { listEvents } from '@/lib/db/queries/events';
import { emit, getRunEventBus, resetRunEventBus } from '@/lib/orchestrator/bus';
import type { AgentSnapshotEntry } from '@/shared/types';

/**
 * Event bus, section 13. One code path serves live delivery and durable
 * replay: publish to subscribers now, persist for reconnects later.
 */

const SNAPSHOT: AgentSnapshotEntry[] = [];
const CONFIG = {
  budgetUsd: 1,
  maxTokens: 1000,
  maxCalls: 100,
  staggerCadenceMs: 0,
  refineEnabled: true,
  searchEnabled: false,
};

function makeRunId(): string {
  return createRun(getDb(), {
    userId: 'unit-user',
    seedPrompt: 'bus seed',
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
  }).id;
}

beforeAll(() => {
  runMigrations();
  getDb().insert(users).values({ id: 'unit-user', displayName: 'Unit', createdAt: Date.now() }).run();
  resetRunEventBus();
});

describe('InMemoryRunEventBus', () => {
  it('delivers live to subscribers and persists gapless seq numbers', async () => {
    const bus = getRunEventBus();
    const runId = makeRunId();
    const seen: string[] = [];
    const off = bus.subscribe(runId, (e) => seen.push(e.type));

    await emit(bus, runId, 'run.started', { steps: ['propose'] });
    await emit(bus, runId, 'step.started', { step: 'propose', round: 1 });

    expect(seen).toEqual(['run.started', 'step.started']);
    off();

    const stored = listEvents(getDb(), runId);
    expect(stored.map((e) => e.seq)).toEqual([1, 2]);
    expect(stored[0]!.id).toBeGreaterThan(0); // the SSE Last-Event-ID
  });

  it('coalesces rapid text deltas live without persisting every token', async () => {
    // Section 13.2: deltas accumulate for 40ms or 40 chars, publish live as
    // one event, and are never persisted per token.
    const bus = getRunEventBus();
    const runId = makeRunId();
    const live: string[] = [];
    bus.subscribe(runId, (e) => {
      if (e.type === 'agent.delta') live.push((e.payload as { text: string }).text);
    });
    for (let i = 0; i < 10; i += 1) {
      bus.publishDelta(runId, 'a', 'propose', { kind: 'text', text: `tok${i} ` });
    }
    await bus.flushDeltas(runId);
    expect(live.length).toBeLessThan(10);
    expect(live.join('')).toBe(Array.from({ length: 10 }, (_, i) => `tok${i} `).join(''));
    expect(listEvents(getDb(), runId).filter((e) => e.type === 'agent.delta')).toHaveLength(0);
  });

  it('replays only events after a seq for reconnects', async () => {
    const bus = getRunEventBus();
    const runId = makeRunId();
    await emit(bus, runId, 'run.started', { steps: [] });
    await emit(bus, runId, 'step.started', { step: 'propose', round: 1 });
    await emit(bus, runId, 'step.completed', { step: 'propose', summary: {} });

    expect((await bus.replay(runId, 1)).map((e) => e.seq)).toEqual([2, 3]);
    expect(await bus.replay(runId, 99)).toEqual([]);
  });

  it('does not leak events across runs', async () => {
    const bus = getRunEventBus();
    const a = makeRunId();
    const b = makeRunId();
    const seenB: string[] = [];
    bus.subscribe(b, (e) => seenB.push(e.type));
    await emit(bus, a, 'run.started', { steps: [] });
    expect(seenB).toEqual([]);
    expect(listEvents(getDb(), b)).toEqual([]);
  });
});
