import { Logger } from '@nestjs/common';
import {
  type NotifyJob,
  type OwnerAlertKind,
  type TgOutboxJob,
  type TgOutboxPriority,
} from '@repo/shared';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { FulfillmentAlertRenderer } from '../fulfillment-alert.renderer';
import { NotifyConsumer, OwnerChatMissingError } from '../notify.consumer';
import type { OrderNotifyRenderer } from '../order-notify.renderer';
import { AlertSourceMissingError, type OwnerAlertRenderer } from '../owner-alert.renderer';
import type { TgOutboxEnqueuer } from '../tg-outbox.enqueuer';
import { fakeSources, type FakeSources } from './order-notify.test-fixtures';

// Critical alerts jump the outbox queue (audit M-1 (b)); a database failure on the last attempt
// still sends the alert with `?` (audit L-3); OwnerChatMissingError is logged once (review m5).
// Synthetic chat ids and refs only.
const OWNER = '111111111';
const NOW = new Date('2030-01-01T09:00:00.000Z');
const dbDown = () => Promise.reject(new Error('database unreachable'));

interface Queued {
  readonly id: string;
  readonly job: TgOutboxJob;
  readonly priority: TgOutboxPriority | undefined;
}

function setup(
  options: {
    sources?: FakeSources;
    bankRender?: () => Promise<string>;
    /** null: no OWNER_ALERT_CHAT_ID at all. */
    chatIds?: string | null;
  } = {},
) {
  const queued: Queued[] = [];
  const outbox = {
    enqueue: (id: string, job: TgOutboxJob, priority?: TgOutboxPriority) => {
      queued.push({ id, job, priority });
      return Promise.resolve();
    },
  } as unknown as TgOutboxEnqueuer;
  const sources = fakeSources(options.sources ?? {});
  const bank = {
    render: options.bankRender ?? (() => Promise.resolve('bank alert')),
  } as unknown as OwnerAlertRenderer;
  const consumer = new NotifyConsumer(
    sources,
    bank,
    outbox,
    buildTestEnv(options.chatIds === null ? {} : { OWNER_ALERT_CHAT_ID: options.chatIds ?? OWNER }),
    {} as OrderNotifyRenderer,
    new FulfillmentAlertRenderer(sources, { now: () => NOW }),
    { now: () => NOW },
  );
  return { consumer, queued };
}

const alertJob = (alert: OwnerAlertKind, refId: string): NotifyJob => ({
  kind: 'OWNER_ALERT',
  alert,
  refId,
});
// BullMQ's attempt fields: attemptsMade counts the attempts already made (0 on the first run).
const attempt = (made: number) => ({ attemptsMade: made, opts: { attempts: 5 } });

describe('owner alert priority and last-attempt fallback', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['tonWalletCompromised', 'cmtransfer1', 'critical'],
    ['workerDown', '1893488400000', 'critical'],
    ['queueStuck', 'cmorder1_1893488400000', 'critical'],
    ['needsReview', 'cmorder1', 'critical'],
    // Bank feed (re-review): security and incoming-money signals are critical too.
    ['foreignChat', 'HUMO_BOT_525969', 'critical'],
    ['bankChatAnomaly', 'UZCARD_BOT_OUTGOING_525969', 'critical'],
    ['listenerStopped', 'BANNED_525969', 'critical'],
    ['listenerDown', '1893488400000_525969', 'critical'],
    ['held', 'cmorder1_cmattempt1', 'normal'],
    ['tonDailyLimit', 'cmorder1_cmattempt1', 'normal'],
    ['chainBreak', 'r9', 'normal'],
  ] as const)('%s goes on the outbox as %s', async (alert, refId, priority) => {
    const { consumer, queued } = setup();
    await expect(consumer.handle({ id: 'n1', data: alertJob(alert, refId) })).resolves.toBe(
      'queued',
    );
    expect(queued.map((q) => q.priority)).toEqual([priority]);
  });

  it('a database failure on an earlier attempt is retried (the job fails, nothing queued)', async () => {
    const { consumer, queued } = setup({ sources: { tonTransfer: dbDown } });
    const job = { id: 'n1', data: alertJob('tonWalletBlocked', 'cmtransfer1'), ...attempt(3) };
    await expect(consumer.handle(job)).rejects.toThrow('database');
    expect(queued).toEqual([]);
  });

  it('on the last attempt the critical alert is still queued, with ? in the gaps', async () => {
    const { consumer, queued } = setup({
      chatIds: `${OWNER},222222222`,
      sources: { tonTransfer: dbDown },
    });
    const job = { id: 'n1', data: alertJob('tonWalletBlocked', 'cmtransfer1'), ...attempt(4) };
    await expect(consumer.handle(job)).resolves.toBe('queued');
    expect(queued).toHaveLength(2);
    for (const { job: out, priority } of queued) {
      expect(priority).toBe('critical');
      expect(out.text).toContain('?');
      expect(out.text).toContain('cmtransfer1'); // our own id, to look the transfer up
      expect(out.text).not.toMatch(/\{\w+\}/);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('job=n1 outcome=render-fallback'));
  });

  it('the same fallback for an order alert keeps only the order id of a composite ref', async () => {
    const { consumer, queued } = setup({ sources: { order: dbDown } });
    const job = { id: 'n1', data: alertJob('held', 'cmorder1_cmattempt1'), ...attempt(4) };
    await consumer.handle(job);
    expect(queued[0]?.job.text).toContain('Buyurtma: cmorder1');
    expect(queued[0]?.job.text).not.toContain('cmattempt1');
  });

  it('a bank-feed alert whose read fails on the last attempt is queued with ?', async () => {
    const { consumer, queued } = setup({ bankRender: dbDown });
    const job = { id: 'n1', data: alertJob('chainBreak', 'r9'), ...attempt(4) };
    await expect(consumer.handle(job)).resolves.toBe('queued');
    expect(queued[0]?.job.text).not.toMatch(/\{\w+\}/);
  });

  it('a deliberately unsent bank-feed alert (row gone) stays unsent on the last attempt', async () => {
    const { consumer, queued } = setup({
      bankRender: () => Promise.reject(new AlertSourceMissingError('chainBreak', 'r9')),
    });
    const job = { id: 'n1', data: alertJob('chainBreak', 'r9'), ...attempt(4) };
    await expect(consumer.handle(job)).rejects.toThrow('notify source missing');
    expect(queued).toEqual([]);
  });

  it('a missing OWNER_ALERT_CHAT_ID is logged once (review m5)', async () => {
    const { consumer } = setup({ chatIds: null });
    await expect(
      consumer.handle({ id: 'n1', data: alertJob('workerDown', '1893488400000') }),
    ).rejects.toBeInstanceOf(OwnerChatMissingError);
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
