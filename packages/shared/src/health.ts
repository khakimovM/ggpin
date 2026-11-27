import { z } from 'zod';

// Written by the worker on an interval with a TTL, read by the API readiness probe. One name
// in one place: a mismatch would report the worker as down forever.
export const WORKER_HEARTBEAT_KEY = 'worker:heartbeat';

// Written by the bankfeed worker process (WORKER_ROLE=bankfeed or all) in every BANK_FEED_MODE,
// read by its container HEALTHCHECK (and the API watchdog later). A separate key: if the bankfeed
// container also wrote `worker:heartbeat`, a live bankfeed would hide a dead fulfillment worker.
// Not `bankfeed:heartbeat` either: that one means "the listener's last healthy round" and is
// absent by design while the feed is off or this process is not the leader.
export const BANKFEED_PROCESS_HEARTBEAT_KEY = 'bankfeed:process-heartbeat';

const DependencyStatusSchema = z.enum(['ok', 'down']);

// `GET /health/ready` (docs/04-API-CONTRACT.md#health). Unenveloped (D-24). `fragment` is
// "disabled" until the Fragment session health check lands in phase 5.
export const ReadinessSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    db: DependencyStatusSchema,
    redis: DependencyStatusSchema,
    worker: DependencyStatusSchema,
    fragment: z.enum(['ok', 'down', 'disabled']),
  })
  .strict();

export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;
export type Readiness = z.infer<typeof ReadinessSchema>;
