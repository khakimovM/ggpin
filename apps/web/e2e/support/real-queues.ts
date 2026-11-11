import { QUEUES } from '@repo/shared';
// bullmq is resolved from the workspace root like every other dependency of the monorepo (the API
// and worker declare it); no new dependency is added to the web app for the e2e support code.
import { Queue } from 'bullmq';
import { REDIS_DB, REDIS_URL } from './real-env';

// The jobs the journeys leave in Redis DB 13. With the bot off (TELEGRAM_BOT_MODE=off) nothing
// consumes the notify and tg-outbox queues, so every top-up (owner alerts, "credited" messages)
// would stay there for ever, and a later run with a bot on this Redis would send them. They are
// removed with `obliterate({ force: true })`, as the backend suites do for their own queues; never
// FLUSHDB, and only on exactly this URL.

const TELEGRAM_QUEUES = [QUEUES.NOTIFY, QUEUES.TG_OUTBOX] as const;

function assertTheE2eRedis(): void {
  if (REDIS_URL !== 'redis://localhost:6379/13' || REDIS_DB !== 13) {
    throw new Error('The e2e queue clean-up runs only on redis://localhost:6379/13.');
  }
}

async function withQueues<T>(run: (queues: Queue[]) => Promise<T>): Promise<T> {
  assertTheE2eRedis();
  const queues = TELEGRAM_QUEUES.map(
    (name) => new Queue(name, { connection: { host: 'localhost', port: 6379, db: REDIS_DB } }),
  );
  try {
    return await run(queues);
  } finally {
    await Promise.all(queues.map((queue) => queue.close()));
  }
}

/** Removes every job of the notify and tg-outbox queues of DB 13. */
export async function clearTelegramQueues(): Promise<void> {
  await withQueues(async (queues) => {
    for (const queue of queues) await queue.obliterate({ force: true });
  });
}

/** Jobs left in those queues, per queue (read only). */
export async function telegramQueueJobCounts(): Promise<Record<string, number>> {
  return withQueues(async (queues) => {
    const counts: Record<string, number> = {};
    for (const queue of queues) {
      const states = await queue.getJobCounts();
      counts[queue.name] = Object.values(states).reduce((sum, count) => sum + count, 0);
    }
    return counts;
  });
}
