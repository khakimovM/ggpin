import { Injectable, Logger } from '@nestjs/common';
import type { DependencyStatus, Readiness } from '@repo/shared';
import { HealthRepository } from './health.repository';

// Per check; the checks run in parallel, so a hung dependency costs the probe at most this.
export const READINESS_CHECK_TIMEOUT_MS = 2_000;

// /ready is unthrottled (orchestrators poll it) and each probe hits Postgres and Redis, so
// without a cache anyone who can reach the route could turn it into a database load generator.
// A result, healthy or not, is served for this long; a constant, not env, so it cannot be
// "tuned" to zero in production by accident.
export const READINESS_CACHE_TTL_MS = 1_500;

class CheckTimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'CheckTimeoutError';
  }
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly repo: HealthRepository) {}

  private cached: { readonly at: number; readonly report: Readiness } | null = null;
  // Single flight: callers arriving while a probe runs share it instead of starting their own.
  private inFlight: Promise<Readiness> | null = null;

  readiness(): Promise<Readiness> {
    if (this.cached !== null && Date.now() - this.cached.at < READINESS_CACHE_TTL_MS) {
      return Promise.resolve({ ...this.cached.report });
    }
    this.inFlight ??= this.probe()
      .then((report) => {
        // Stamped when the probe finished, so a slow probe still gets a full window.
        this.cached = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight.then((report) => ({ ...report }));
  }

  // Never rejects: every check maps its own failure to 'down'.
  private async probe(): Promise<Readiness> {
    const [db, redis, worker] = await Promise.all([
      this.check('db', () => this.repo.pingDatabase()),
      this.check('redis', () => this.repo.pingRedis()),
      this.check('worker', async () => {
        if (!(await this.repo.workerHeartbeatPresent())) throw new Error('no heartbeat');
      }),
    ]);
    return {
      status: db === 'ok' && redis === 'ok' && worker === 'ok' ? 'ok' : 'degraded',
      db,
      redis,
      worker,
      // Not checked until the Fragment session health check exists (phase 5); it will then be
      // reported here but, with the backup provider, will not by itself make the API unready.
      fragment: 'disabled',
    };
  }

  private async check(name: string, probe: () => Promise<void>): Promise<DependencyStatus> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CheckTimeoutError()), READINESS_CHECK_TIMEOUT_MS);
        }),
      ]);
      return 'ok';
    } catch (error) {
      // Debug only: orchestrators poll this every few seconds. Name/code only, never the
      // message: driver messages are not guaranteed free of connection details.
      this.logger.debug(`${name} not ready: ${describe(error)}`);
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name} ${code}` : error.name;
}
