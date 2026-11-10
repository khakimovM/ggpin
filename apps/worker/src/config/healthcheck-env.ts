import { z } from 'zod';

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
