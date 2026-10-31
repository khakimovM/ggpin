import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { WORKER_HEARTBEAT_KEY } from '@repo/shared';
import { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';

// Real Postgres (`*_test`) and real Redis (logical DB 15). The worker is simulated by writing
// its heartbeat key directly, exactly as HeartbeatService does.
describe('GET /api/v1/health/ready (real Postgres + Redis)', () => {
  const env = buildE2eEnv();
  let app: NestFastifyApplication;
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(env.REDIS_URL);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env)],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
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
    await redis.set(
      WORKER_HEARTBEAT_KEY,
      JSON.stringify({ at: new Date().toISOString(), pid: 1 }),
      'PX',
      30_000,
    );
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      worker: 'ok',
      fragment: 'disabled',
    });
  });

  it('503 degraded when the worker heartbeat is missing', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: 'degraded',
      db: 'ok',
      redis: 'ok',
      worker: 'down',
      fragment: 'disabled',
    });
  });

  it('503 again once the heartbeat TTL expires', async () => {
    await redis.set(WORKER_HEARTBEAT_KEY, 'x', 'PX', 300);
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
  });

  it('/health/live stays 200', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200, { status: 'ok' });
  });
});
