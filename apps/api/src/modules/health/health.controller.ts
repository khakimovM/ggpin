import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  // Liveness only: the process is up and serving HTTP. Readiness (db, redis, worker,
  // fragment) arrives with those dependencies in phase 1 (docs/04-API-CONTRACT.md#health).
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
