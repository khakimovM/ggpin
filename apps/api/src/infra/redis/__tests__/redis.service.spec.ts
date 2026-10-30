import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../../../config/config.module';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { RedisModule } from '../redis.module';
import { RedisService } from '../redis.service';

describe('RedisService', () => {
  it('builds a lazy client from config without connecting, and closes cleanly with no Redis', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(buildTestEnv({ REDIS_URL: 'redis://:secret@example.test:6380/2' })),
        RedisModule,
      ],
    }).compile();
    await moduleRef.init();

    const { client } = moduleRef.get(RedisService);
    expect(client.status).toBe('wait');
    expect(client.options).toMatchObject({
      host: 'example.test',
      port: 6380,
      db: 2,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

    await expect(moduleRef.close()).resolves.toBeUndefined();
    expect(client.status).toBe('end');
  });
});
