import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Readiness } from '@repo/shared';
import { HealthService } from './health.service';

// Only the part of the Fastify reply this controller uses; avoids importing fastify types
// directly (it is a transitive dependency of @nestjs/platform-fastify).
interface StatusReply {
  status(statusCode: number): unknown;
}

// Both routes are unenveloped (D-24, docs/04-API-CONTRACT.md#health): orchestrators and
// uptime checks read `status` at the top level.
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Liveness: the process is up and serving HTTP. Touches no dependency, so it answers even
  // with Postgres and Redis down.
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Readiness: 200 when db, redis and worker are ok, otherwise 503 with the same body so a
  // load balancer stops routing here while an operator can still see which part is down.
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: StatusReply): Promise<Readiness> {
    const report = await this.health.readiness();
    if (report.status !== 'ok') reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
