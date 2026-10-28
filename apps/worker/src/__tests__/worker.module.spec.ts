import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../worker.module';

// Smoke test: the module graph resolves and the context closes cleanly. Phase 1 replaces it
// with assertions on the registered queue consumers.
describe('WorkerModule', () => {
  it('boots and closes as an application context', async () => {
    const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    await expect(app.close()).resolves.toBeUndefined();
  });
});
