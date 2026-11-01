import { getQueueOptionsToken, getQueueToken, type RegisterQueueOptions } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import { QUEUE_JOB_DEFAULTS, QUEUE_NAMES } from '@repo/shared';
import { withFakeInfra } from '../../../__tests__/fake-infra';
import { AppConfigModule } from '../../../config/config.module';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { FulfillOrderEnqueuer } from '../fulfill-order-enqueuer';
import { QueueModule } from '../queue.module';

describe('QueueModule (api, producer)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await withFakeInfra(
      Test.createTestingModule({
        imports: [
          AppConfigModule.forRoot(buildTestEnv({ REDIS_URL: 'redis://example.test:6380' })),
          QueueModule,
        ],
      }),
    ).compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it.each(QUEUE_NAMES)('registers queue %s with its retry/retention defaults', (name) => {
    expect(moduleRef.get(getQueueToken(name), { strict: false })).toBeDefined();
    const options = moduleRef.get<RegisterQueueOptions>(getQueueOptionsToken(name), {
      strict: false,
    });
    expect(options.defaultJobOptions).toEqual(QUEUE_JOB_DEFAULTS[name]);
  });

  it('provides the single fulfill-order enqueue path', () => {
    expect(moduleRef.get(FulfillOrderEnqueuer, { strict: false })).toBeInstanceOf(
      FulfillOrderEnqueuer,
    );
  });

  it('connects from REDIS_URL and fails fast instead of buffering while Redis is down', () => {
    const options = moduleRef.get<RegisterQueueOptions>(getQueueOptionsToken(QUEUE_NAMES[0]), {
      strict: false,
    });
    expect(options.connection).toEqual({
      url: 'redis://example.test:6380',
      enableOfflineQueue: false,
    });
  });
});
