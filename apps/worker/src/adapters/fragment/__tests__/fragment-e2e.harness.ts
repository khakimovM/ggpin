import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@repo/db';
import { FRAGMENT_HEALTH_KEY, QUEUES, type NotifyJob } from '@repo/shared';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

// Shared by the Fragment session e2e suites (phase 5 S7): the FragmentSession table and the Redis
// `fragment:health` key are process-wide state (one ACTIVE row at most), so every suite starts
// and ends with neither. Every fetch these suites use is a fake: nothing reaches fragment.com.

export async function clearFragmentState(db: PrismaClient, redis: Redis): Promise<void> {
  await db.fragmentSession.deleteMany({});
  await redis.del(FRAGMENT_HEALTH_KEY);
}

type FragmentAlertJob = Extract<NotifyJob, { kind: 'OWNER_ALERT' }>;

function isFragmentAlert(data: unknown): data is FragmentAlertJob {
  if (typeof data !== 'object' || data === null) return false;
  const alert: unknown = Reflect.get(data, 'alert');
  return (
    Reflect.get(data, 'kind') === 'OWNER_ALERT' &&
    (alert === 'fragmentSessionDead' || alert === 'fragmentSessionRestored')
  );
}

/** The Fragment session alerts in the notify queue (any state), oldest first. */
export async function fragmentAlerts(notify: Queue): Promise<FragmentAlertJob[]> {
  expect(notify.name).toBe(QUEUES.NOTIFY);
  const jobs = await notify.getJobs(['waiting', 'delayed', 'prioritized', 'completed', 'failed']);
  return jobs
    .filter((job) => isFragmentAlert(job.data))
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((job) => job.data as FragmentAlertJob);
}

export async function removeFragmentAlerts(notify: Queue): Promise<void> {
  const jobs = await notify.getJobs(['waiting', 'delayed', 'prioritized', 'completed', 'failed']);
  for (const job of jobs) if (isFragmentAlert(job.data)) await job.remove();
}

/** Every line the worker's Nest loggers print while a test runs (for the redaction checks). */
export function captureLogs(): { readonly lines: string[]; restore(): void } {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    }),
  );
  return {
    lines,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
