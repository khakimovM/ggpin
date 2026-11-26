import { Logger } from '@nestjs/common';
import {
  FULFILLMENT_ALERT_KINDS,
  ORDER_NOTIFY_KINDS,
  tgOutboxJobSchema,
  type NotifyJob,
  type TgOutboxJob,
} from '@repo/shared';
import { UnrecoverableError } from 'bullmq';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { FulfillmentAlertRenderer } from '../fulfillment-alert.renderer';
import { NotifyConsumer } from '../notify.consumer';
import type { OwnerAlertRenderer } from '../owner-alert.renderer';
import type { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';
import {
  fakeSources,
  orderRenderer,
  orderRow,
  type FakeSources,
} from './order-notify.test-fixtures';

// Phase 5 S6: ORDER_* and fulfillment alerts are routed (before S6 they failed as unrouted).
// Synthetic chat ids; the outbox is an in-memory map that drops a repeated id like BullMQ does.
const PRIMARY = '111111111';
const PARTNER = '222222222';

function setup(fake: FakeSources, outboxFails?: Error) {
  const sent = new Map<string, TgOutboxJob>();
  const outbox = {
    enqueue: (id: string, job: TgOutboxJob) => {
      if (outboxFails !== undefined) return Promise.reject(outboxFails);
      if (!sent.has(id)) sent.set(id, tgOutboxJobSchema.parse(job));
      return Promise.resolve();
    },
  } as unknown as TgOutboxEnqueuer;
  const config = buildTestEnv({ OWNER_ALERT_CHAT_ID: `${PRIMARY},${PARTNER}` });
  const sources = fakeSources(fake);
  const consumer = new NotifyConsumer(
    sources,
    {} as OwnerAlertRenderer,
    outbox,
    config,
    orderRenderer(fake),
    new FulfillmentAlertRenderer(sources, { now: () => new Date('2030-01-01T09:00:00Z') }),
    { now: () => new Date('2030-01-01T09:00:00Z') },
  );
  return { consumer, sent };
}

const accepted = { order: () => Promise.resolve(orderRow()) };

describe('notify consumer: order messages', () => {
  let info: jest.SpyInstance;
  beforeEach(() => {
    info = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => info.mockRestore());

  it.each(ORDER_NOTIFY_KINDS)('%s is routed (no longer unrouted-kind)', async (kind) => {
    const row = orderRow({
      // A refunded order was never delivered (a delivered one refunded later is an admin refund).
      status: kind === 'ORDER_REFUNDED' ? 'REFUNDED' : 'DELIVERED',
      deliveredAt: kind === 'ORDER_REFUNDED' ? null : new Date(),
    });
    const { consumer } = setup({
      order: () =>
        Promise.resolve(kind === 'ORDER_ACCEPTED' || kind === 'ORDER_REVIEW' ? orderRow() : row),
      orderRefund: () => Promise.resolve({ amountTiyin: 100n }),
    });
    await expect(consumer.handle({ id: 'n1', data: { kind, refId: 'cmorder1' } })).resolves.toBe(
      'queued',
    );
  });

  it('a repeated job queues ONE message under order-<orderId>-<event>', async () => {
    const { consumer, sent } = setup(accepted);
    const data: NotifyJob = { kind: 'ORDER_ACCEPTED', refId: 'cmorder1' };
    await consumer.handle({ id: 'n1', data });
    await consumer.handle({ id: 'n2', data });
    expect([...sent.keys()]).toEqual(['order-cmorder1-accepted']);
    expect(sent.get('order-cmorder1-accepted')?.chatId).toBe('777000111');
  });

  it('a blocked user: completed as skipped-blocked, nothing queued', async () => {
    const blocked = orderRow({ user: { ...orderRow().user, botBlockedAt: new Date() } });
    const { consumer, sent } = setup({ order: () => Promise.resolve(blocked) });
    await expect(
      consumer.handle({ id: 'n1', data: { kind: 'ORDER_ACCEPTED', refId: 'cmorder1' } }),
    ).resolves.toBe('skipped-blocked');
    expect(sent.size).toBe(0);
    expect(info).toHaveBeenCalledWith('job=n1 outcome=skipped-blocked');
  });

  it('a missing order fails as unrecoverable', async () => {
    const { consumer } = setup({});
    await expect(
      consumer.handle({ id: 'n1', data: { kind: 'ORDER_DELIVERED', refId: 'gone' } }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('an unexpected error is retried and logged redacted (no data of the failed call)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    class PrismaClientValidationError extends Error {
      override name = 'PrismaClientValidationError';
    }
    const leak = new PrismaClientValidationError(
      'Invalid `order.findUnique()` invocation\n  where: { id: "needle_order_secret" }',
    );
    const { consumer } = setup({ order: () => Promise.reject(leak) });
    await expect(
      consumer.handle({ id: 'n9', data: { kind: 'ORDER_ACCEPTED', refId: 'cmorder1' } }),
    ).rejects.toBe(leak);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('job=n9 outcome=error');
    expect(line).toContain('PrismaClientValidationError');
    expect(line).not.toContain('needle_order_secret');
    warn.mockRestore();
  });
});

describe('notify consumer: fulfillment owner alerts (D-53)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it.each(FULFILLMENT_ALERT_KINDS)('%s goes to every partner, one job each', async (alert) => {
    const { consumer, sent } = setup(accepted);
    const data: NotifyJob = { kind: 'OWNER_ALERT', alert, refId: 'cmorder1' };
    await expect(consumer.handle({ id: 'n1', data })).resolves.toBe('queued');
    await consumer.handle({ id: 'n2', data });
    expect([...sent.keys()]).toEqual([
      `alert-${alert}-cmorder1-${PRIMARY}`,
      `alert-${alert}-cmorder1-${PARTNER}`,
    ]);
    const texts = [...sent.values()].map((job) => job.text);
    expect(texts[0]).toBe(texts[1]);
  });
});
