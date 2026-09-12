import { describe, expect, it } from 'vitest';

import { nextStep, plannedSteps, stepIndex, STEP_ORDER } from '@/lib/orchestrator/context';
import { isTerminal, STEP_NAMES, type RunStatus, type StepName } from '@/shared/constants';

/**
 * State machine, sections 11.1 and 11.2.
 *
 * `propose -> debate -> refine -> vote -> reveal -> done`, with refine skipped
 * when the run config disables it. Run-status transitions themselves are owned
 * by the engine and the route handlers; what is pinned here is the step order
 * every one of them must agree on.
 */
describe('step order', () => {
  it('walks propose -> debate -> refine -> vote -> reveal -> done', () => {
    const walked: StepName[] = ['propose'];
    let step = nextStep('propose', true);
    while (step !== 'done') {
      walked.push(step);
      step = nextStep(step, true);
    }
    expect(walked).toEqual(['propose', 'debate', 'refine', 'vote', 'reveal']);
  });

  it('skips refine when the run config disables it', () => {
    expect(nextStep('debate', false)).toBe('vote');
    expect(nextStep('debate', true)).toBe('refine');
    expect(plannedSteps(false)).toEqual(['propose', 'debate', 'vote', 'reveal']);
    expect(plannedSteps(true)).toEqual(['propose', 'debate', 'refine', 'vote', 'reveal']);
  });

  it('stepIndex is monotonic over the walk, with done last', () => {
    const order: (StepName | 'done')[] = [...STEP_ORDER, 'done'];
    const indexes = order.map(stepIndex);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    expect(stepIndex('done')).toBeGreaterThan(stepIndex('reveal'));
  });

  it('STEP_ORDER matches the shared STEP_NAMES', () => {
    expect([...STEP_ORDER]).toEqual([...STEP_NAMES]);
  });
});

describe('run status', () => {
  it('completed, failed and aborted are terminal; created, running and paused are not', () => {
    const terminal: RunStatus[] = ['completed', 'failed', 'aborted'];
    const live: RunStatus[] = ['created', 'running', 'paused'];
    for (const status of terminal) expect(isTerminal(status)).toBe(true);
    for (const status of live) expect(isTerminal(status)).toBe(false);
  });
});
