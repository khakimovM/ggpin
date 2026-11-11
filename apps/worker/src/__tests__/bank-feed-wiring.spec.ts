import { Test } from '@nestjs/testing';
import { BANK_FEED_CLIENT } from '../bank-feed/client/bank-feed-client';
import { BANK_FEED_LISTENER } from '../bank-feed/client/bank-feed-client.provider';
import { BankFeedListener } from '../bank-feed/client/bank-feed-listener';
import { FakeBankFeedClient } from '../bank-feed/client/fake-bank-feed.client';
import { buildTestEnv } from '../config/__tests__/test-env';
import { WorkerModule } from '../worker.module';
import { fakeRedisClient, withFakeInfra } from './fake-infra';

// BANK_FEED_MODE in the real module graph (network edges faked, nothing started).
async function compile(overrides: Record<string, string>) {
  const moduleRef = await withFakeInfra(
    Test.createTestingModule({ imports: [WorkerModule.register(buildTestEnv(overrides))] }),
    fakeRedisClient(),
    new Map(),
  ).compile();
  moduleRef.useLogger(false);
  return moduleRef;
}

describe('bank-feed wiring', () => {
  it('off (default): no client and no listener', async () => {
    const moduleRef = await compile({});
    expect(moduleRef.get(BANK_FEED_CLIENT, { strict: false })).toBeNull();
    expect(moduleRef.get(BANK_FEED_LISTENER, { strict: false })).toBeNull();
    await moduleRef.close();
  });

  it('fake: the in-memory client and its listener', async () => {
    const moduleRef = await compile({
      BANK_FEED_MODE: 'fake',
      BANK_FEED_HUMO_BOT_ID: '111000111',
      BANK_FEED_UZCARD_BOT_ID: '222000222',
    });
    expect(moduleRef.get(BANK_FEED_CLIENT, { strict: false })).toBeInstanceOf(FakeBankFeedClient);
    expect(moduleRef.get(BANK_FEED_LISTENER, { strict: false })).toBeInstanceOf(BankFeedListener);
    await moduleRef.close();
  });
});
