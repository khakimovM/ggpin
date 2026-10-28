import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../worker.module';

describe('WorkerModule', () => {
  it('boots as an application context without an HTTP server', async () => {
    const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    expect(app).toBeDefined();
    expect('getHttpServer' in app).toBe(false);
    await app.close();
  });
});
