import type { JobState, Queue } from 'bullmq';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import {
  FAILED_RETRY_AFTER_MS,
  ORPHAN_BATCH,
  OUTCOME_SETTLE_MS,
  OrphanRequeueService,
} from '../orphan-requeue.service';

// S9 m1: a stored message without a decision gets its `bm-<id>` job back. The queue is a fake
// with the few calls the service makes; the stored-rows query is checked by its arguments.
const NOW = new Date('2030-05-03T10:00:00.000Z');

interface FakeJob {
  state: JobState | 'unknown';
  finishedOn?: number;
  retry: jest.Mock<Promise<void>, [string, object]>;
  updateData: jest.Mock<Promise<void>, [object]>;
  /** The order the two writes happened in. */
  calls: string[];
  getState: () => Promise<JobState | 'unknown'>;
}

function fakeJob(state: FakeJob['state'], finishedOn?: number): FakeJob {
  const job: FakeJob = {
    state,
    ...(finishedOn === undefined ? {} : { finishedOn }),
    calls: [],
    retry: jest.fn<Promise<void>, [string, object]>(() => {
      job.calls.push('retry');
      return Promise.resolve();
    }),
    updateData: jest.fn<Promise<void>, [object]>(() => {
      job.calls.push('updateData');
      return Promise.resolve();
    }),
    getState: () => Promise.resolve(job.state),
  };
  return job;
}

function setup(ids: string[], jobs: Record<string, FakeJob>) {
  const findMany = jest.fn<Promise<{ id: string }[]>, [object]>(() =>
    Promise.resolve(ids.map((id) => ({ id }))),
  );
  const prisma = { client: { bankMessage: { findMany } } };
  const add = jest.fn<Promise<object>, [string, object, { jobId: string }]>().mockResolvedValue({});
  const queue = { getJob: (jobId: string) => Promise.resolve(jobs[jobId]), add };
  const service = new OrphanRequeueService(
    prisma as unknown as PrismaService,
    queue as unknown as Queue,
  );
  service['logger'].warn = jest.fn();
  return { service, findMany, add };
}

describe('OrphanRequeueService', () => {
  it('reads undecided messages older than the settle time, of the last week, newest first, in batches', async () => {
    const { service, findMany } = setup([], {});
    await service.run(NOW);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          outcome: null,
          createdAt: {
            gte: new Date(NOW.getTime() - 7 * 24 * 3_600_000),
            lt: new Date(NOW.getTime() - OUTCOME_SETTLE_MS),
          },
        },
        orderBy: { createdAt: 'desc' },
        take: ORPHAN_BATCH,
      }),
    );
  });

  it('adds a missing job under its own id, leaves a live one, retries an old failure', async () => {
    const oldFailure = fakeJob('failed', NOW.getTime() - FAILED_RETRY_AFTER_MS);
    const freshFailure = fakeJob('failed', NOW.getTime() - FAILED_RETRY_AFTER_MS + 1);
    const delayed = fakeJob('delayed');
    const { service, add } = setup(['cm3lost', 'cm3old', 'cm3fresh', 'cm3wait'], {
      'bm-cm3old': oldFailure,
      'bm-cm3fresh': freshFailure,
      'bm-cm3wait': delayed,
    });
    await expect(service.run(NOW)).resolves.toEqual({ added: 1, retried: 1 });
    expect(add).toHaveBeenCalledWith(
      'bank-message',
      { bankMessageId: 'cm3lost' },
      { jobId: 'bm-cm3lost' },
    );
    expect(oldFailure.retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    // B4: the data is reset first (used-up wait counters dropped), then the job is retried.
    expect(oldFailure.updateData).toHaveBeenCalledWith({ bankMessageId: 'cm3old' });
    expect(oldFailure.calls).toEqual(['updateData', 'retry']);
    expect(freshFailure.retry).not.toHaveBeenCalled();
    expect(freshFailure.updateData).not.toHaveBeenCalled();
    expect(delayed.retry).not.toHaveBeenCalled();
  });
});
