import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { withFakeInfra } from '../../../__tests__/fake-infra';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { HealthRepository } from '../health.repository';

// HTTP surface of /health with the dependency probes faked (no Postgres/Redis needed). The
// real-dependency version lives in health-ready.e2e-spec.ts.
describe('/api/v1/health', () => {
  let app: NestFastifyApplication;
  const repo = {
    pingDatabase: jest.fn<Promise<void>, []>(),
    pingRedis: jest.fn<Promise<void>, []>(),
    workerHeartbeatPresent: jest.fn<Promise<boolean>, []>(),
  };

  beforeAll(async () => {
    const moduleRef = await withFakeInfra(
      Test.createTestingModule({ imports: [AppModule.register(buildTestEnv())] }),
    )
      .overrideProvider(HealthRepository)
      .useValue(repo)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    repo.pingDatabase.mockResolvedValue(undefined);
    repo.pingRedis.mockResolvedValue(undefined);
    repo.workerHeartbeatPresent.mockResolvedValue(true);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET live', () => {
    it('returns {status:"ok"} without touching any dependency', async () => {
      repo.pingDatabase.mockRejectedValue(new Error('down'));
      repo.pingRedis.mockRejectedValue(new Error('down'));
      const res = await request(app.getHttpServer()).get('/api/v1/health/live');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(repo.pingDatabase).not.toHaveBeenCalled();
    });

    it('is served only under the versioned /api prefix', async () => {
      await request(app.getHttpServer()).get('/api/health/live').expect(404);
      await request(app.getHttpServer()).get('/health/live').expect(404);
    });
  });

  describe('GET ready', () => {
    it('200 with the unenveloped contract shape when everything is up', async () => {
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

    it('503 degraded, same shape, when the worker heartbeat is missing', async () => {
      repo.workerHeartbeatPresent.mockResolvedValue(false);
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

    it('503 when the database is down', async () => {
      repo.pingDatabase.mockRejectedValue(new Error('down'));
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: 'degraded', db: 'down' });
    });
  });
});
