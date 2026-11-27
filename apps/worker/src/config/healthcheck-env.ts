import { isBlank, type WorkerRole } from '@repo/shared';
import { z } from 'zod';
import { parseWorkerRole } from './worker-role';

const HealthcheckEnvSchema = z.object({ REDIS_URL: z.url({ protocol: /^rediss?$/ }) });

/**
 * The container HEALTHCHECK needs only REDIS_URL: the full worker config would refuse to load
 * without the other secrets, and the probe must not hold them. Returns null instead of throwing
 * and never echoes the value (it may carry a password).
 */
export function loadHealthcheckRedisUrl(source: NodeJS.ProcessEnv = process.env): string | null {
  const parsed = HealthcheckEnvSchema.safeParse({ REDIS_URL: source['REDIS_URL'] });
  return parsed.success ? parsed.data.REDIS_URL : null;
}

/**
 * The role whose process key the probe reads (D-76), by the worker's own rules: unset means `all`
 * only when NODE_ENV is exactly development or test; otherwise (production, unset, misspelt) unset,
 * `all` or an unknown value is null (unhealthy, SA F-3).
 */
export function loadHealthcheckRole(source: NodeJS.ProcessEnv = process.env): WorkerRole | null {
  const blankless = (name: string) => (isBlank(source[name]) ? undefined : source[name]);
  const role = parseWorkerRole({
    NODE_ENV: blankless('NODE_ENV'),
    WORKER_ROLE: blankless('WORKER_ROLE'),
  }).role;
  return role ?? null;
}
