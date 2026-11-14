import { EventEmitter } from 'node:events';
import { getQueueToken } from '@nestjs/bullmq';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { QUEUE_NAMES } from '@repo/shared';
import { RedisService } from '../infra/redis/redis.service';
import { BankMessageProcessor } from '../bank-feed/bank-message.processor';
import { CardLimitProcessor } from '../bank-feed/card-limit.processor';
import { FulfillOrderProcessor } from '../fulfillment/fulfill-order.processor';
import { TopupExpireProcessor } from '../bank-feed/topup-expire.processor';
import type { ScheduleRule } from '../infra/queue/boot-scheduler';
import { PriceSyncProcessor } from '../pricing-sync/price-sync.processor';
import { PaymentReconcileProcessor } from '../reconcile/payment-reconcile.processor';

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

/** A queue stand-in: an EventEmitter (QueueErrorLogger subscribes) with the producer calls. */
export class FakeQueue extends EventEmitter {
  readonly upsertJobScheduler = jest
    .fn<Promise<{ delay: number }>, [string, ScheduleRule, { name: string; data: object }]>()
    .mockResolvedValue({ delay: 0 });
  readonly add = jest.fn<Promise<object>, [string, object]>().mockResolvedValue({});
}

// BullMQ Queues connect as soon as they are constructed (lazyConnect does not stop them), so
// unit tests replace each queue instance and the Redis client. The queue *options* providers
// stay real, which is what the wiring tests assert on. Processors are replaced by a plain
// object: @nestjs/bullmq then finds no @Processor metadata and opens no BullMQ Worker (which
// would connect to Redis).
export function withFakeInfra(
  builder: TestingModuleBuilder,
  client: FakeRedisClient = fakeRedisClient(),
  queues: Map<string, FakeQueue> = new Map(),
): TestingModuleBuilder {
  let result = builder.overrideProvider(RedisService).useValue({ client });
  for (const name of QUEUE_NAMES) {
    const queue = new FakeQueue();
    queues.set(name, queue);
    result = result.overrideProvider(getQueueToken(name)).useValue(queue);
  }
  return result
    .overrideProvider(PriceSyncProcessor)
    .useValue({})
    .overrideProvider(BankMessageProcessor)
    .useValue({})
    .overrideProvider(CardLimitProcessor)
    .useValue({})
    .overrideProvider(TopupExpireProcessor)
    .useValue({})
    .overrideProvider(PaymentReconcileProcessor)
    .useValue({})
    .overrideProvider(FulfillOrderProcessor)
    .useValue({});
}
