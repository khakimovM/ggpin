import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { configureApp } from '../../../app.setup';

describe('GET /api/v1/health/live', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(buildTestEnv())],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns {status:"ok"}', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('is served only under the versioned /api prefix', async () => {
    await request(app.getHttpServer()).get('/api/health/live').expect(404);
    await request(app.getHttpServer()).get('/health/live').expect(404);
  });
});
