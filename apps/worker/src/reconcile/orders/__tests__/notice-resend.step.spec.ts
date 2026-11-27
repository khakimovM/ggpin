import { Logger } from '@nestjs/common';
import { RECONCILE_BATCH_LIMIT, REVIEW_NOTICE_RESEND_WINDOW_MS } from '@repo/shared';
import type { FulfillReplay } from '../../../fulfillment/fulfill-replay';
import { OrderLockUnavailableError, type LockedRun } from '../../../fulfillment/order-lock';
import { NoticeResendStep } from '../notice-resend.step';
import type { OrderSweepsRepository, SweepCursor } from '../order-sweeps.repository';
import type { ReconcileOrderLock } from '../reconcile-order-lock';

// D-64 (3), Q-19: HELD / NEEDS_REVIEW notices are re-added (stable ids) only inside the window,
// under the order lock, through FulfillReplay.

const NOW = 1_790_000_000_000;
const row = (id: string): SweepCursor => ({ id, createdAt: new Date(NOW - 60_000) });

function build(options: { busy?: boolean; lockDown?: boolean; page?: SweepCursor[] } = {}) {
  const repository = { noticePage: jest.fn().mockResolvedValue(options.page ?? [row('ordera')]) };
  const replay = { resendHeldOrReview: jest.fn().mockResolvedValue('RESENT') };
  let locked = 0;
  const lock: ReconcileOrderLock = {
    run: async <T>(_orderId: string, fn: () => Promise<T>): Promise<LockedRun<T>> => {
      if (options.lockDown === true) throw new OrderLockUnavailableError();
      if (options.busy === true) return { busy: true };
      locked += 1;
      return { busy: false, value: await fn() };
    },
  };
  const step = new NoticeResendStep(
    repository as unknown as OrderSweepsRepository,
    replay as unknown as FulfillReplay,
    lock,
  );
  return { step, repository, replay, locks: () => locked };
}

describe('NoticeResendStep', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('asks only for orders that entered HELD / NEEDS_REVIEW inside the window', async () => {
    const { step, repository } = build();
    await step.run({ nowMs: NOW });
    expect(repository.noticePage).toHaveBeenCalledWith(
      new Date(NOW - REVIEW_NOTICE_RESEND_WINDOW_MS),
      null,
      RECONCILE_BATCH_LIMIT,
    );
  });

  it('replays each order under its lock', async () => {
    const { step, replay, locks } = build({ page: [row('ordera'), row('orderb')] });
    const report = await step.run({ nowMs: NOW });
    expect(replay.resendHeldOrReview.mock.calls).toEqual([['ordera'], ['orderb']]);
    expect(locks()).toBe(2);
    expect(report).toEqual({
      step: 'noticeResend',
      counts: { resent: 2 },
      ids: ['ordera', 'orderb'],
    });
  });

  it('a moved or missing order is counted, nothing sent', async () => {
    const { step, replay } = build({ page: [row('ordera'), row('orderb')] });
    replay.resendHeldOrReview.mockResolvedValueOnce('MOVED').mockResolvedValueOnce('MISSING');
    expect((await step.run({ nowMs: NOW })).counts).toEqual({ moved: 1, missing: 1 });
  });

  it('CR F5: an UNNAMED hold is counted on its own, logged once per order, never resent', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { step, replay } = build({ page: [row('ordera'), row('orderb')] });
    replay.resendHeldOrReview.mockResolvedValue('UNNAMED');
    const first = await step.run({ nowMs: NOW });
    expect(first).toEqual({
      step: 'noticeResend',
      counts: { unnamed: 2 },
      ids: ['ordera', 'orderb'],
    });
    expect((await step.run({ nowMs: NOW + 600_000 })).counts).toEqual({ unnamed: 2 });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('busy: not replayed this tick', async () => {
    const { step, replay } = build({ busy: true });
    expect((await step.run({ nowMs: NOW })).counts).toEqual({ busy: 1 });
    expect(replay.resendHeldOrReview).not.toHaveBeenCalled();
  });

  it('a failing replay is logged, the next order goes on', async () => {
    const { step, replay } = build({ page: [row('ordera'), row('orderb')] });
    replay.resendHeldOrReview.mockRejectedValueOnce(new Error('db down'));
    expect((await step.run({ nowMs: NOW })).counts).toEqual({ failed: 1, resent: 1 });
  });

  it('Redis cannot give the lock: the step stops', async () => {
    const { step } = build({ lockDown: true });
    await expect(step.run({ nowMs: NOW })).rejects.toBeInstanceOf(OrderLockUnavailableError);
  });
});
