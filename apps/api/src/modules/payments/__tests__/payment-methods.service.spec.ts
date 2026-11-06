import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { RedisService } from '../../../infra/redis/redis.service';
import type { BankFeedHealth } from '../bank-feed-health';
import type { CardPoolService } from '../card-pool.service';
import {
  PAYMENT_METHODS_CACHE_KEY,
  PAYMENT_METHODS_CACHE_SEC,
  PaymentMethodsService,
} from '../payment-methods.service';

const NOW = new Date('2026-11-05T10:00:00.000Z');

function setup(redis: { get: jest.Mock; set: jest.Mock }) {
  const bankFeed = { isAlive: jest.fn(() => Promise.resolve(true)) };
  const cards = {
    availability: jest.fn(() => Promise.resolve({ HUMO: true, UZCARD: false })),
  };
  const service = new PaymentMethodsService(
    { client: redis } as unknown as RedisService,
    bankFeed as unknown as BankFeedHealth,
    cards as unknown as CardPoolService,
    buildTestEnv(),
    { now: () => NOW },
  );
  return { service, cards };
}

describe('PaymentMethodsService cache (S4-06)', () => {
  it('a miss computes and stores the answer for 5 s; a hit computes nothing', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: jest.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve('OK');
      }),
    };
    const { service, cards } = setup(redis);
    const first = await service.methods();
    expect(first[0]).toMatchObject({
      available: true,
      banks: [
        { bank: 'HUMO', available: true },
        { bank: 'UZCARD', available: false },
      ],
    });
    expect(redis.set).toHaveBeenCalledWith(
      PAYMENT_METHODS_CACHE_KEY,
      JSON.stringify(first),
      'EX',
      PAYMENT_METHODS_CACHE_SEC,
    );
    expect(await service.methods()).toEqual(first);
    expect(cards.availability).toHaveBeenCalledTimes(1);
  });

  it('a Redis error on read or write is a miss, never an error', async () => {
    const redis = {
      get: jest.fn(() => Promise.reject(new Error('redis down'))),
      set: jest.fn(() => Promise.reject(new Error('redis down'))),
    };
    const { service, cards } = setup(redis);
    expect((await service.methods())[0]).toMatchObject({ available: true });
    expect(cards.availability).toHaveBeenCalledTimes(1);
  });

  it('a value that is not JSON or not the response shape is a miss', async () => {
    for (const raw of ['not json', '{"code":"P2P_CARD"}']) {
      const redis = {
        get: jest.fn(() => Promise.resolve(raw)),
        set: jest.fn(() => Promise.resolve('OK')),
      };
      const { service, cards } = setup(redis);
      expect((await service.methods())[0]).toMatchObject({ code: 'P2P_CARD', available: true });
      expect(cards.availability).toHaveBeenCalledTimes(1);
    }
  });
});
