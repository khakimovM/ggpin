import { Injectable } from '@nestjs/common';
import { WORKER_HEARTBEAT_KEY } from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

// Raw dependency probes. Each one throws (or resolves false) on failure; timeouts and the
// ok/down mapping are the service's job.
@Injectable()
export class HealthRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async pingDatabase(): Promise<void> {
    await this.prisma.client.$queryRaw`SELECT 1`;
  }

  async pingRedis(): Promise<void> {
    const reply = await this.redis.client.ping();
    if (reply !== 'PONG') throw new Error('unexpected PING reply');
  }

  // The worker writes this key with a TTL (apps/worker/src/heartbeat); present = alive.
  async workerHeartbeatPresent(): Promise<boolean> {
    return (await this.redis.client.exists(WORKER_HEARTBEAT_KEY)) === 1;
  }
}
