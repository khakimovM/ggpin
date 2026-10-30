import { Injectable, Logger } from '@nestjs/common';
import type { DependencyStatus, Readiness } from '@repo/shared';
import { HealthRepository } from './health.repository';

// Per check; the checks run in parallel, so a hung dependency costs the probe at most this.
export const READINESS_CHECK_TIMEOUT_MS = 2_000;

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

  async readiness(): Promise<Readiness> {
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
