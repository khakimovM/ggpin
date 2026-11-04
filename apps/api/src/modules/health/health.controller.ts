import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Readiness } from '@repo/shared';
import { Public } from '../../common/auth/public.decorator';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { HealthService } from './health.service';

// Only the part of the Fastify reply this controller uses; avoids importing fastify types
// directly (it is a transitive dependency of @nestjs/platform-fastify).
interface StatusReply {
  status(statusCode: number): unknown;
}

// Both routes are unenveloped (D-24, docs/04-API-CONTRACT.md#health): orchestrators and
// uptime checks read `status` at the top level. Probes poll every few seconds, so both routes
// are also exempt from the per-IP rate limit. Public: probes carry no session.
@Public()
@RawResponse()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Liveness: the process is up and serving HTTP. Touches no dependency, so it answers even
  // with Postgres and Redis down.
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Readiness: 503 only when Postgres or Redis is down, with the same body so a load balancer
  // stops routing here while an operator can still see which part is down. A missing worker
  // heartbeat (D-30.1) keeps HTTP 200 and shows as `status:"degraded"`, `worker:"down"`: the API
  // still serves catalog and wallet reads without the worker, so a worker restart must not pull
  // the API out of the load balancer.
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: StatusReply): Promise<Readiness> {
    const report = await this.health.readiness();
    if (report.db === 'down' || report.redis === 'down') {
      reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return report;
  }
}
