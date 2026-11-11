import type { Queue } from 'bullmq';

// The API e2e files run one at a time (--runInBand, and one run at a time through the e2e lock),
// and nothing in them consumes the `notify` queue: every job that appears there while a file
// runs is that file's, and without a clean-up it stays in the test Redis for good (S9 B5).
const STATES = ['waiting', 'delayed', 'prioritized', 'paused', 'completed', 'failed'] as const;

/** The ids of the jobs the queue holds now (call in beforeAll). */
export async function queueJobIds(queue: Queue): Promise<Set<string>> {
  const jobs = await queue.getJobs([...STATES]);
  return new Set(jobs.flatMap((job) => (job.id === undefined ? [] : [job.id])));
}

/** Removes every job that was not there in `before` (call in afterAll). Returns how many. */
export async function removeJobsAddedSince(
  queue: Queue,
  before: ReadonlySet<string>,
): Promise<number> {
  let removed = 0;
  for (const job of await queue.getJobs([...STATES])) {
    if (job.id === undefined || before.has(job.id)) continue;
    await job.remove();
    removed += 1;
  }
  return removed;
}
