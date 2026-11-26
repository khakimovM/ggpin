import { Redis } from 'ioredis';
import { workerRoleHeartbeatKeys, type WorkerRole } from '@repo/shared';
import { loadHealthcheckRedisUrl, loadHealthcheckRole } from '../config/healthcheck-env';

/** Container HEALTHCHECK (`node dist/healthcheck/healthcheck.js`). */
const CONNECT_TIMEOUT_MS = 3_000;
const COMMAND_TIMEOUT_MS = 3_000;

export interface HeartbeatReader {
  get(key: string): Promise<string | null>;
}

/**
 * Healthy = every process key of this role exists (D-76): `worker:heartbeat` for fulfillment,
 * `bankfeed:process-heartbeat` for bankfeed, both for all. The worker rewrites them every 10 s
 * with a 30 s TTL (HeartbeatService), so a dead or wedged event loop and a Redis outage both make
 * the key disappear. Deliberately not `bankfeed:heartbeat`: that key exists only in
 * BANK_FEED_MODE=live on the leader, and the bankfeed container must be healthy with the feed off.
 */
export async function workerIsHealthy(reader: HeartbeatReader, role: WorkerRole): Promise<boolean> {
  for (const key of workerRoleHeartbeatKeys(role)) {
    if ((await reader.get(key)) === null) return false;
  }
  return true;
}

async function run(): Promise<number> {
  const url = loadHealthcheckRedisUrl();
  if (url === null) {
    process.stderr.write('healthcheck: REDIS_URL is missing or invalid\n');
    return 1;
  }
  const role = loadHealthcheckRole();
  if (role === null) {
    process.stderr.write('healthcheck: WORKER_ROLE is missing or invalid\n');
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
    if (await workerIsHealthy(redis, role)) return 0;
    process.stderr.write(`healthcheck: the ${role} heartbeat key is missing\n`);
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
