import { Logger } from '@nestjs/common';
import {
  FULFILLMENT_ALERT_KINDS,
  ORDER_NOTIFY_KINDS,
  type NotifyJob,
  type TgOutboxJob,
} from '@repo/shared';
import { UnrecoverableError } from 'bullmq';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { NotifySourcesRepository } from '../notify-sources.repository';
import { NotifyConsumer } from '../notify.consumer';
import type { OwnerAlertRenderer } from '../owner-alert.renderer';
import type { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';

// Phase 5 widened the notify job (ORDER_* kinds, fulfillment alerts) before the API can render
// them (S6). Such a job must fail loudly and send NOTHING: never completed as if it were sent.
function setup() {
  const enqueued: TgOutboxJob[] = [];
  const render = jest.fn(() => Promise.resolve('alert text'));
  const sources = {
    payment: jest.fn(() => Promise.resolve(null)),
    balance: jest.fn(() => Promise.resolve(0n)),
  };
  const outbox = {
    enqueue: (_id: string, job: TgOutboxJob) => {
      enqueued.push(job);
      return Promise.resolve();
    },
  } as unknown as TgOutboxEnqueuer;
  const consumer = new NotifyConsumer(
    sources as unknown as NotifySourcesRepository,
    { render } as unknown as OwnerAlertRenderer,
    outbox,
    buildTestEnv({ OWNER_ALERT_CHAT_ID: '111111111' }),
  );
  return { consumer, enqueued, render, sources };
}

describe('notify consumer: kinds it cannot route yet', () => {
  let errorLog: jest.SpyInstance;
  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorLog.mockRestore());

  it.each(ORDER_NOTIFY_KINDS)('%s fails as unrecoverable and sends nothing', async (kind) => {
    const { consumer, enqueued, sources } = setup();
    const job: NotifyJob = { kind, refId: 'cm0order1' };
    await expect(consumer.handle({ id: 'n1', data: job })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(enqueued).toEqual([]);
    expect(sources.payment).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it.each(FULFILLMENT_ALERT_KINDS)(
    'the %s owner alert fails as unrecoverable and sends nothing',
    async (alert) => {
      const { consumer, enqueued, render } = setup();
      const job: NotifyJob = { kind: 'OWNER_ALERT', alert, refId: 'cm0order1' };
      await expect(consumer.handle({ id: 'n1', data: job })).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(enqueued).toEqual([]);
      expect(render).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
    },
  );

  it('logs at error level, with the job id and the outcome only (no order id, no text)', async () => {
    const { consumer } = setup();
    await consumer
      .handle({ id: 'n7', data: { kind: 'ORDER_ACCEPTED', refId: 'cm0order1' } })
      .catch(() => undefined);
    expect(errorLog).toHaveBeenCalledWith('job=n7 outcome=unrouted-kind');
  });

  it('a bank-feed alert still goes out as before', async () => {
    const { consumer, enqueued } = setup();
    const job: NotifyJob = { kind: 'OWNER_ALERT', alert: 'chainBreak', refId: 'r9' };
    await expect(consumer.handle({ id: 'n1', data: job })).resolves.toBe('queued');
    expect(enqueued).toHaveLength(1);
    expect(errorLog).not.toHaveBeenCalled();
  });
});
