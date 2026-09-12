import type { StepName } from '@/shared/constants';

/**
 * Idempotency keys, section 11.6.
 *
 * Format: `run:{runId}:step:{step}:agent:{agentId}:round:{round}:attempt-agnostic`
 *
 * The trailing `:attempt-agnostic` segment is part of the frozen format string
 * in section 11.6 and documents the property that matters: retries of the same
 * logical task reuse ONE key, so the unique index on
 * `agent_messages.task_key` guarantees a crashed or restarted server can never
 * double-charge a call no matter how many attempts it made.
 *
 * Because the key is the primary idempotency mechanism, it is deliberately
 * built from stable identities only (run, step, agent, round) and never from
 * wall-clock time, attempt number, or a random id.
 */

/**
 * The pseudo-agent id used for the one non-agent call in the run: the reveal
 * synthesis (section 11.3, "1 total, non-agent"). It never matches a seat, so
 * the client renders no avatar for it.
 */
export const SYNTHESIS_AGENT_ID = 'synthesis';

export interface TaskKeyInput {
  runId: string;
  step: StepName;
  agentId: string;
  round: number;
}

function assertPart(value: string, label: string): void {
  if (!value || value.includes(':')) {
    // A colon inside a part would make the key ambiguous to parse or grep and
    // could in principle let two different tasks collide.
    throw new Error(`Invalid ${label} for a task key: ${JSON.stringify(value)}`);
  }
}

/**
 * The key for a task that is uniquely identified by (run, step, agent, round).
 * Used by propose, debate, vote and reveal.
 */
export function taskKey(input: TaskKeyInput): string {
  const { runId, step, agentId, round } = input;
  assertPart(runId, 'runId');
  assertPart(agentId, 'agentId');
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`Invalid round for a task key: ${String(round)}`);
  }
  return `run:${runId}:step:${step}:agent:${agentId}:round:${round}:attempt-agnostic`;
}

/**
 * The refine variant (section 11.3): refine fans out per proposal, so the same
 * agent can legitimately run more than one refine task inside the same step
 * and round. Without the target proposal id those two tasks would share a key
 * and the second would be silently skipped as "already done".
 */
export function refineTaskKey(input: TaskKeyInput & { proposalId: string }): string {
  const { runId, step, agentId, round, proposalId } = input;
  assertPart(runId, 'runId');
  assertPart(agentId, 'agentId');
  assertPart(proposalId, 'proposalId');
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`Invalid round for a task key: ${String(round)}`);
  }
  return `run:${runId}:step:${step}:agent:${agentId}:round:${round}:target:${proposalId}:attempt-agnostic`;
}

/**
 * The prefix every task of one step of one run shares. Handy for the
 * `run.paused` payload, for logging, and for the resume filter, which needs to
 * know which keys belong to the step it is re-entering.
 */
export function taskKeyPrefix(runId: string, step: StepName): string {
  return `run:${runId}:step:${step}:`;
}
