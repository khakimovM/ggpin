import { EventEmitter } from 'node:events';
import { getQueueToken } from '@nestjs/bullmq';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { QUEUE_NAMES } from '@repo/shared';
import { RedisService } from '../infra/redis/redis.service';

export interface FakeRedisClient {
  set: jest.Mock<Promise<string>, [string, string, string, number]>;
  eval: jest.Mock<Promise<number>, [string, number, string, string]>;
}

export function fakeRedisClient(): FakeRedisClient {
  return {
    set: jest.fn<Promise<string>, [string, string, string, number]>().mockResolvedValue('OK'),
    eval: jest.fn<Promise<number>, [string, number, string, string]>().mockResolvedValue(1),
  };
}

// BullMQ Queues connect as soon as they are constructed (lazyConnect does not stop them), so
// unit tests replace each queue instance and the Redis client. The queue *options* providers
// stay real, which is what the wiring tests assert on.
export function withFakeInfra(
  builder: TestingModuleBuilder,
  client: FakeRedisClient = fakeRedisClient(),
): TestingModuleBuilder {
  let result = builder.overrideProvider(RedisService).useValue({ client });
  for (const name of QUEUE_NAMES) {
    result = result.overrideProvider(getQueueToken(name)).useValue(new EventEmitter());
  }
  return result;
}
