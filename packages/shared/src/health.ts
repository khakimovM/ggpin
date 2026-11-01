import { z } from 'zod';

// Written by the worker on an interval with a TTL, read by the API readiness probe. One name
// in one place: a mismatch would report the worker as down forever.
export const WORKER_HEARTBEAT_KEY = 'worker:heartbeat';

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
