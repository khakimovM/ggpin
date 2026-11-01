import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { DestinationStream } from 'pino';
import { withFakeInfra } from '../../__tests__/fake-infra';
import { AppModule } from '../../app.module';
import { configureApp } from '../../app.setup';
import { buildTestEnv } from '../../config/__tests__/test-env';
import { HealthRepository } from '../../modules/health/health.repository';
import { createHttpAdapter } from '../http/create-http-adapter';
import type { RateLimit } from '../http/http-limits';
import { HttpTestController } from './http-test.controller';

export interface HttpTestAppOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly rateLimit?: RateLimit;
  /** Captures log output; without it the app logs at level silent. */
  readonly logDestination?: DestinationStream;
}

// The real AppModule + the real adapter factory + the real configureApp, with Postgres,
// Redis and the queues faked, plus the test-only controller. No external service needed.
export async function createHttpTestApp(
  options: HttpTestAppOptions = {},
): Promise<NestFastifyApplication> {
  // Silent unless a test captures logs: keeps the test output readable.
  const env = buildTestEnv({ LOG_LEVEL: 'silent', ...options.env });
  const healthRepository = {
    pingDatabase: () => Promise.resolve(),
    pingRedis: () => Promise.resolve(),
    workerHeartbeatPresent: () => Promise.resolve(true),
  };
  const moduleRef = await withFakeInfra(
    Test.createTestingModule({
      imports: [
        AppModule.register(env, {
          rateLimit: options.rateLimit,
          logDestination: options.logDestination,
        }),
      ],
      controllers: [HttpTestController],
    }),
  )
    .overrideProvider(HealthRepository)
    .useValue(healthRepository)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
    // Same as main.ts: boot logs are held until configureApp installs the Pino logger.
    bufferLogs: true,
  });
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
