import { Injectable, Logger } from '@nestjs/common';
import { AdminDashboardResponseSchema, scrubSecretsInText } from '@repo/shared';
import { z } from 'zod';
import { RedisService } from '../../../infra/redis/redis.service';
import { withinMs } from '../../payments/within-ms';

/** How long one computed period is reused (CR M1 / SA-S4-1). */
export const DASHBOARD_CACHE_TTL_SEC = 60;
const TIMEOUT_MS = 400;
export const DASHBOARD_CACHE_PREFIX = 'adm:dash:';

/** What is cached: the period and its figures. Alerts are "now" and are never cached. */
export const DashboardFiguresSchema = AdminDashboardResponseSchema.omit({ alerts: true });
export type DashboardFigures = z.infer<typeof DashboardFiguresSchema>;

/**
 * The dashboard's 60 s figure cache in Redis, shared by every API process. Best effort both
 * ways: Redis down, slow or holding a corrupt value is a miss, never an error. The key carries
 * no role: the figures are the same for every role allowed to read them (the service takes no
 * role; admin-read-misc e2e computes them fresh for OWNER and OPERATOR and compares).
 */
@Injectable()
export class AdminDashboardCache {
  private readonly logger = new Logger(AdminDashboardCache.name);

  constructor(private readonly redis: RedisService) {}

  async get(key: string): Promise<DashboardFigures | null> {
    try {
      const raw = await withinMs(
        this.redis.client.get(DASHBOARD_CACHE_PREFIX + key),
        TIMEOUT_MS,
        'redis',
      );
      if (raw === null) return null;
      const parsed = DashboardFiguresSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      this.warn('get', error);
      return null;
    }
  }

  async set(key: string, figures: DashboardFigures): Promise<void> {
    try {
      await withinMs(
        this.redis.client.set(
          DASHBOARD_CACHE_PREFIX + key,
          JSON.stringify(figures),
          'EX',
          DASHBOARD_CACHE_TTL_SEC,
        ),
        TIMEOUT_MS,
        'redis',
      );
    } catch (error) {
      this.warn('set', error);
    }
  }

  private warn(op: string, error: unknown): void {
    const reason =
      error instanceof Error ? scrubSecretsInText(error.message).slice(0, 200) : 'unknown';
    this.logger.warn(`dashboard cache ${op} failed: ${reason}`);
  }
}
