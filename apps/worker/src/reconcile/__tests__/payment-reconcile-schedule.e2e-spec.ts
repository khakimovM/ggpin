import { QUEUES } from '@repo/shared';
import { Queue } from 'bullmq';
import { HOUR } from '../../bank-feed/__tests__/matcher-e2e.fixtures';
import { buildE2eEnv } from '../../config/__tests__/e2e-env';
import { PAYMENT_RECONCILE_SCHEDULE } from '../payment-reconcile.scheduler';

// The daily reconciliation's cron on the real Redis DB 15 (split from payment-reconcile.e2e-spec.ts
// for the file size rule): a scheduler of its own id is added, read back and removed.
describe('payment-reconcile schedule (real Redis)', () => {
  it('the cron fires at 03:00 Asia/Tashkent (22:00 UTC)', async () => {
    const env = buildE2eEnv();
    const queue = new Queue(QUEUES.PAYMENT_RECONCILE, { connection: { url: env.REDIS_URL } });
    const id = `${PAYMENT_RECONCILE_SCHEDULE.id}-e2e-${String(Date.now())}`;
    try {
      await queue.upsertJobScheduler(id, PAYMENT_RECONCILE_SCHEDULE.rule, {
        name: PAYMENT_RECONCILE_SCHEDULE.jobName,
        data: {},
      });
      const scheduler = await queue.getJobScheduler(id);
      const next = new Date(scheduler?.next ?? 0);
      expect(next.getUTCHours()).toBe(22);
      expect(next.getUTCMinutes()).toBe(0);
      expect(next.getTime()).toBeGreaterThan(Date.now());
      expect(next.getTime() - Date.now()).toBeLessThanOrEqual(24 * HOUR);
    } finally {
      await queue.removeJobScheduler(id);
      const left = (await queue.getDelayed()).filter((j) => j.repeatJobKey === id);
      for (const job of left) await job.remove();
      await queue.close();
    }
  });
});
