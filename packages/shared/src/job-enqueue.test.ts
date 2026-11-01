import { describe, expect, it } from 'vitest';
import { decideEnqueue, JOB_STATES, type EnqueueAction, type JobStateName } from './job-enqueue';

const EXPECTED: Record<JobStateName, EnqueueAction> = {
  unknown: 'add',
  completed: 'replace',
  failed: 'replace',
  active: 'keep',
  delayed: 'keep',
  prioritized: 'keep',
  waiting: 'keep',
  'waiting-children': 'keep',
};

describe('decideEnqueue', () => {
  it.each(JOB_STATES)('classifies BullMQ state %s', (state) => {
    expect(decideEnqueue(state)).toBe(EXPECTED[state]);
  });

  it('classifies every state exactly once (no state forgotten in the expectation table)', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...JOB_STATES].sort());
  });

  it('treats a missing job as add', () => {
    expect(decideEnqueue(undefined)).toBe('add');
  });

  it('never replaces a job that is queued or running (that would risk a double run)', () => {
    for (const state of [
      'active',
      'waiting',
      'delayed',
      'prioritized',
      'waiting-children',
    ] as const) {
      expect(decideEnqueue(state)).not.toBe('replace');
    }
  });
});
