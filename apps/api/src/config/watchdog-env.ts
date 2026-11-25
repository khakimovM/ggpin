import { z } from 'zod';

/**
 * The API's worker watchdog (phase 5 S6, D-34 (12)). Part of EnvSchema. The worker heartbeat
 * expires 30 s after its last beat and the watchdog looks every 30 s, so anything under a minute
 * would alert on one slow beat; over an hour the owner would hear of a dead worker far too late.
 */
export const watchdogShape = {
  // No heartbeat for this long (ms) = one `workerDown` owner alert per outage.
  WORKER_DOWN_ALERT_AFTER_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(120_000),
} as const;
