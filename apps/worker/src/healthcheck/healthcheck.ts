import { Redis } from 'ioredis';
import { WORKER_HEARTBEAT_KEY } from '@repo/shared';
import { loadHealthcheckRedisUrl } from '../config/healthcheck-env';

/** Container HEALTHCHECK (`node dist/healthcheck/healthcheck.js`). */
const CONNECT_TIMEOUT_MS = 3_000;
const COMMAND_TIMEOUT_MS = 3_000;

export interface HeartbeatReader {
  get(key: string): Promise<string | null>;
}

/**
 * Healthy = the worker's own heartbeat key exists. The worker rewrites `worker:heartbeat` every
 * 10 s with a 30 s TTL (HeartbeatService), so a dead or wedged event loop and a Redis outage
 * both make the key disappear. Deliberately not `bankfeed:heartbeat`: that key exists only in
 * BANK_FEED_MODE=live on the leader, and the worker must be healthy with the feed off.
 */
export async function workerIsHealthy(reader: HeartbeatReader): Promise<boolean> {
  return (await reader.get(WORKER_HEARTBEAT_KEY)) !== null;
}

async function run(): Promise<number> {
  const url = loadHealthcheckRedisUrl();
  if (url === null) {
    process.stderr.write('healthcheck: REDIS_URL is missing or invalid\n');
    return 1;
  }
  // No retries: one probe, one answer. The URL (it may carry a password) is never printed.
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    if (await workerIsHealthy(redis)) return 0;
    process.stderr.write('healthcheck: worker heartbeat key is missing\n');
    return 1;
  } catch {
    process.stderr.write('healthcheck: redis is unreachable\n');
    return 1;
  } finally {
    redis.disconnect();
  }
}

if (require.main === module) {
  void run().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
