import { Logger } from '@nestjs/common';
import { NOTIFY_JOB_NAME, isWorkerOnlySecretName, notifyJobId } from '@repo/shared';
import {
  blocksWallet,
  heldNotices,
  noticeJob,
  tonNoticesFor,
  walletBlockedNotice,
  witnessConflictNotice,
} from '../ton-notices';
import { TonNotifier, type NoticeQueue } from '../ton-notifier';
import type { PayoutState } from '../ton-payout';

const base: PayoutState = {
  transferId: 'tr1',
  transferStatus: 'BROADCAST',
  txHash: null,
  orderId: 'ord1',
  orderStatus: 'PROCESSING',
  orderReason: null,
  attemptStatus: 'SENT',
  witnessConflict: false,
};
const state = (patch: Partial<PayoutState>): PayoutState => ({ ...base, ...patch });

describe('TON notices come from the final rows (replay-safe)', () => {
  it('delivered, review, the critical seqno and bounce alerts', () => {
    expect(tonNoticesFor(state({ transferStatus: 'CONFIRMED', orderStatus: 'DELIVERED' }))).toEqual(
      [{ kind: 'ORDER_DELIVERED', orderId: 'ord1' }],
    );
    expect(
      tonNoticesFor(state({ transferStatus: 'CONSUMED_UNMATCHED', orderStatus: 'NEEDS_REVIEW' })),
    ).toEqual([
      { kind: 'ORDER_REVIEW', orderId: 'ord1' },
      { kind: 'ALERT', alert: 'needsReview', refId: 'ord1' },
      { kind: 'ALERT', alert: 'tonSeqnoUnmatched', refId: 'tr1' },
    ]);
    expect(
      tonNoticesFor(state({ transferStatus: 'BOUNCED', orderStatus: 'NEEDS_REVIEW' })),
    ).toContainEqual({ kind: 'ALERT', alert: 'tonBounced', refId: 'tr1' });
    // Still in flight, or provably never sent: nobody is told anything.
    expect(tonNoticesFor(base)).toEqual([]);
    expect(tonNoticesFor(state({ transferStatus: 'EXPIRED' }))).toEqual([]);
    // A self-test transfer has no order: only the owner's critical alert.
    expect(
      tonNoticesFor(
        state({ transferStatus: 'CONSUMED_UNMATCHED', orderId: null, orderStatus: null }),
      ),
    ).toEqual([{ kind: 'ALERT', alert: 'tonSeqnoUnmatched', refId: 'tr1' }]);
  });

  it('a hold tells the customer "being checked" and the owner why, per attempt (review m7)', () => {
    expect(heldNotices('ord1', 'att1', 'LOW_BALANCE')).toEqual([
      { kind: 'ORDER_REVIEW', orderId: 'ord1' },
      { kind: 'ALERT', alert: 'held', refId: 'ord1_att1' },
    ]);
    expect(heldNotices('ord1', 'att1', 'LIMIT_DAILY')).toContainEqual({
      kind: 'ALERT',
      alert: 'tonDailyLimit',
      refId: 'ord1_att1',
    });
    // A later hold of the same order (another attempt) is a new owner alert; the customer's
    // "being checked" stays one per order.
    const ids = (attemptId: string) =>
      heldNotices('ord1', attemptId, 'LOW_BALANCE').map((n) => notifyJobId(noticeJob(n)));
    expect(ids('att1')[0]).toBe(ids('att2')[0]);
    expect(ids('att1')[1]).not.toBe(ids('att2')[1]);
  });

  it('a transfer left unresolved while its order is in review blocks the wallet (review M4)', () => {
    for (const transferStatus of ['SIGNED', 'BROADCAST'] as const) {
      expect(tonNoticesFor(state({ transferStatus, orderStatus: 'NEEDS_REVIEW' }))).toEqual([
        { kind: 'ORDER_REVIEW', orderId: 'ord1' },
        { kind: 'ALERT', alert: 'needsReview', refId: 'ord1' },
        { kind: 'ALERT', alert: 'tonWalletBlocked', refId: 'tr1' },
      ]);
    }
    // Decided transfers do not block; neither does one still watched by its sender.
    expect(
      tonNoticesFor(state({ transferStatus: 'BOUNCED', orderStatus: 'NEEDS_REVIEW' })),
    ).not.toContainEqual(walletBlockedNotice('tr1'));
    expect(tonNoticesFor(base)).not.toContainEqual(walletBlockedNotice('tr1'));
    // The stable id: one alert per blocking transfer, whoever raises it.
    expect(notifyJobId(noticeJob(walletBlockedNotice('tr1')))).toBe('alert-tonWalletBlocked-tr1');
  });

  it('blocksWallet: strictly older than TON_CONFIRM_TIMEOUT_MS by the database clock', () => {
    const created = new Date(1_000_000);
    expect(blocksWallet(created, 1_000_000 + 180_000, 180_000)).toBe(false);
    expect(blocksWallet(created, 1_000_000 + 180_001, 180_000)).toBe(true);
  });

  it('the notifier queues each notice once by a stable id, and never throws', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const added: { name: string; jobId: string }[] = [];
    let failNext = true;
    const queue: NoticeQueue = {
      add: (name, _data, options) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('redis down'));
        }
        added.push({ name, jobId: options.jobId });
        return Promise.resolve();
      },
    };
    const notifier = new TonNotifier(queue);
    const notices = tonNoticesFor(
      state({ transferStatus: 'BOUNCED', orderStatus: 'NEEDS_REVIEW' }),
    );
    await expect(
      notifier.send([...notices, { kind: 'ALERT', alert: 'held', refId: 'not a valid id!' }]),
    ).resolves.toBeUndefined();
    // The first add failed (logged by id and error kind only), the invalid id was never queued,
    // the rest went through.
    expect(logged.mock.calls).toEqual([
      ['ton notice order-ord1-review not queued: Error'],
      ['ton notice ALERT has an invalid id: not queued'],
    ]);
    logged.mockRestore();
    expect(added.map((a) => a.jobId)).toEqual(
      notices.slice(1).map((n) => notifyJobId(noticeJob(n))),
    );
    expect(added.every((a) => a.name === NOTIFY_JOB_NAME)).toBe(true);
    expect(notifyJobId(noticeJob(notices[0] ?? { kind: 'ORDER_REVIEW', orderId: 'x' }))).toBe(
      notifyJobId(noticeJob({ kind: 'ORDER_REVIEW', orderId: 'ord1' })),
    );
  });

  it('a witness conflict is a critical owner alert per transfer, one job id on a replay (m3)', () => {
    const job = noticeJob(witnessConflictNotice('cm0transfer1'));
    expect(job).toEqual({
      kind: 'OWNER_ALERT',
      alert: 'tonWitnessConflict',
      refId: 'cm0transfer1',
    });
    expect(notifyJobId(job)).toBe(notifyJobId(noticeJob(witnessConflictNotice('cm0transfer1'))));
  });

  it('the witness alert comes from the kept fact on every look, whatever the verdict (RR2-4)', () => {
    const reviewed = state({ orderStatus: 'NEEDS_REVIEW', attemptStatus: 'UNKNOWN' });
    expect(tonNoticesFor(reviewed)).not.toContainEqual(witnessConflictNotice('tr1'));
    expect(tonNoticesFor({ ...reviewed, witnessConflict: true })).toContainEqual(
      witnessConflictNotice('tr1'),
    );
    // A SELFTEST transfer (no order) and a transfer decided later still carry it.
    const selftest = state({ orderId: null, orderStatus: null, witnessConflict: true });
    expect(tonNoticesFor(selftest)).toEqual([witnessConflictNotice('tr1')]);
    expect(
      tonNoticesFor(
        state({ transferStatus: 'CONFIRMED', orderStatus: 'NEEDS_REVIEW', witnessConflict: true }),
      ),
    ).toContainEqual(witnessConflictNotice('tr1'));
  });
});

describe('the API refuses to boot with the TON secrets (rules/60, plan §5)', () => {
  it.each(['TON_MNEMONIC_ENC', 'WALLET_ENC_KEY', 'WALLET_ENC_KEY_FILE', 'TON_API_KEY'])(
    '%s is a worker-only name',
    (name) => {
      expect(isWorkerOnlySecretName(name)).toBe(true);
    },
  );

  it('TON_WALLET_ADDRESS is not a secret (plan §5: not on the worker-only list)', () => {
    expect(isWorkerOnlySecretName('TON_WALLET_ADDRESS')).toBe(false);
  });
});
