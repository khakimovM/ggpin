import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { WORKER_HEARTBEAT_KEY } from '@repo/shared';
import { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';

// Real Postgres (`*_test`) and real Redis (logical DB 15). The worker is simulated by writing
// its heartbeat key directly, exactly as HeartbeatService does.
//
// /ready caches its result for a short window (READINESS_CACHE_TTL_MS). Instead of sleeping for
// "TTL + margin" (which couples the test to that constant and to machine speed), each test
// polls until the endpoint reflects the state it just set up, with a generous upper bound. What
// is asserted is behaviour: the status flips, and the body is exactly the contract shape.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 15_000;

describe('GET /api/v1/health/ready (real Postgres + Redis)', () => {
  const env = buildE2eEnv();
  let app: NestFastifyApplication;
  let redis: Redis;

  // Polls until the body shows the state just set up. Since D-30.1 ok and degraded-by-worker
  // both answer 200, the status code alone cannot tell a fresh result from a cached stale one.
  async function pollBody(expected: Record<string, string>): Promise<request.Response> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
      const body = res.body as Record<string, unknown>;
      if (Object.entries(expected).every(([key, value]) => body[key] === value)) return res;
      if (Date.now() > deadline) {
        throw new Error(`/ready never matched ${JSON.stringify(expected)}; last ${res.text}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  async function workerBeats(): Promise<void> {
    await redis.set(
      WORKER_HEARTBEAT_KEY,
      JSON.stringify({ at: new Date().toISOString(), pid: 1 }),
      'PX',
      60_000,
    );
  }

  beforeAll(async () => {
    redis = new Redis(env.REDIS_URL);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env)],
    }).compile();
    // The shipped adapter (proxy trust, body limits, ...), not a bare FastifyAdapter.
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(async () => {
    await redis.del(WORKER_HEARTBEAT_KEY);
  });

  afterAll(async () => {
    await redis.del(WORKER_HEARTBEAT_KEY);
    await redis.quit();
    await app.close();
  });

  it('200 ok when the worker heartbeat exists', async () => {
    await workerBeats();
    const res = await pollBody({ status: 'ok', worker: 'ok' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      worker: 'ok',
      fragment: 'disabled',
    });
  });

  it('200 degraded when the worker heartbeat is missing (D-30.1)', async () => {
    const res = await pollBody({ status: 'degraded', worker: 'down' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'degraded',
      db: 'ok',
      redis: 'ok',
      worker: 'down',
      fragment: 'disabled',
    });
  });

  it('flips ok -> degraded (still 200) once the heartbeat disappears, and back when it returns', async () => {
    await workerBeats();
    await pollBody({ status: 'ok', worker: 'ok' });
    // Deleting the key is what an expired TTL looks like to the API; it avoids racing a short
    // real TTL against a slow first request. The HTTP status stays 200, so the body is polled.
    await redis.del(WORKER_HEARTBEAT_KEY);
    const down = await pollBody({ status: 'degraded', worker: 'down' });
    expect(down.status).toBe(200);
    await workerBeats();
    await pollBody({ status: 'ok', worker: 'ok' });
  });

  it('/health/live stays 200', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200, { status: 'ok' });
  });
});
