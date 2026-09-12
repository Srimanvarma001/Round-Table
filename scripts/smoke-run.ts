/**
 * One real run against the live provider (section 19.3: `pnpm smoke`).
 *
 * Creates a run, starts it, waits for a terminal status and prints the winner,
 * the metrics and the cost. Exits non-zero when the run fails. Budget-capped
 * by the run's own config snapshot, so a smoke test cannot runaway-spend.
 *
 * `pnpm smoke -- --seed "a tool that saves me an hour every week"`
 */

import './env';

import { eq } from 'drizzle-orm';

import { buildAgentSnapshot } from '@/app/api/_lib/http';
import { config } from '@/lib/config';
import { getDb, nowMs } from '@/lib/db/client';
import { getMeAgent } from '@/lib/db/queries/agents';
import { createRun, getRun, updateRun } from '@/lib/db/queries/runs';
import { getSettingsOrDefaults } from '@/lib/db/queries/settings';
import { runs } from '@/lib/db/schema';
import { getRunEventBus } from '@/lib/orchestrator/bus';
import { executeRun } from '@/lib/orchestrator/engine';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const seed =
    argValue('--seed') ?? 'A small tool that saves me at least one hour every week.';

  const db = getDb();
  if (!getMeAgent(db)) {
    console.error('smoke: no seats are seeded; run `pnpm seed` first.');
    process.exit(1);
  }

  const settings = getSettingsOrDefaults(db);
  const { snapshot } = buildAgentSnapshot();

  const run = createRun(db, {
    userId: config.APP_USER_ID,
    seedPrompt: seed,
    seedMode: 'specific',
    status: 'created',
    currentStep: 'propose',
    stepIndex: 0,
    round: 1,
    agentSnapshot: snapshot,
    configSnapshot: {
      budgetUsd: 0.25, // smoke spends little even if the table is generous
      maxTokens: settings.maxTokens,
      maxCalls: settings.maxCalls,
      staggerCadenceMs: settings.staggerCadenceMs,
      refineEnabled: true,
      searchEnabled: false, // no Tavily dependency in the smoke path
    },
    profileId: null,
    tokensIn: 0,
    tokensOut: 0,
    costEstimateUsd: 0,
    llmCalls: 0,
    pauseRequested: false,
  });

  console.log(`smoke: run ${run.id}`);
  console.log(`smoke: seed "${seed}"`);
  console.log('smoke: starting the engine (this calls the real provider)...');

  // Stream progress to the console as events land.
  const bus = getRunEventBus();
  const unsubscribe = bus.subscribe(run.id, (event) => {
    if (event.type === 'step.started') {
      const payload = event.payload as { step: string };
      console.log(`smoke: step ${payload.step}`);
    } else if (event.type === 'agent.failed') {
      const payload = event.payload as { code: string; message: string };
      console.warn(`smoke: seat failed (${payload.code}): ${payload.message}`);
    } else if (event.type === 'budget.warning') {
      const payload = event.payload as { usedUsd: number; limitUsd: number };
      console.warn(`smoke: budget warning $${payload.usedUsd.toFixed(4)} of $${payload.limitUsd.toFixed(2)}`);
    } else if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.aborted') {
      console.log(`smoke: ${event.type}`);
    }
  });

  // Mark it running exactly as the start route does, then walk the loop.
  updateRun(db, run.id, { status: 'running', startedAt: nowMs() });

  const result = await executeRun(run.id);
  unsubscribe();

  const fresh = getRun(db, run.id);
  if (!fresh) throw new Error('the run row disappeared mid-run');

  console.log('');
  console.log(`smoke: final status ${result.status}`);
  console.log(
    `smoke: cost $${fresh.costEstimateUsd.toFixed(4)} · ${fresh.llmCalls} calls · ` +
      `${fresh.tokensIn + fresh.tokensOut} tokens`,
  );

  if (result.status !== 'completed') {
    console.error(`smoke: FAILED — run ended ${result.status}: ${fresh.errorMessage ?? 'no message'}`);
    process.exit(1);
  }

  console.log(`smoke: OK — replay it on /runs/${run.id}`);
}

void eq;
void runs;
main().catch((err) => {
  console.error(`smoke: FAILED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
