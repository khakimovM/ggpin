import { randomBytes } from 'node:crypto';
import { transitionOrder } from '@repo/db';
import type { TonPayRequest, TonPayResult } from '../../ton/ton-payout';
import type { TonPayer } from '../fulfill-tokens';
import { attemptsOf, ledgerOf, orderRow } from './fulfill-e2e.fixtures';
import { useFulfillE2e } from './fulfill-e2e.harness';

// Phase 5 S9f (owner 2026-11-18): the second run of an order whose FIRST payout the chain showed
// after all (attempt 1 FAILED, its transfer EXPIRED with a `late` fact, e.g. SEQNO_HELD). The
// database refuses every "nothing left" move beside it (`assertNoLivePayout`): the RECIPIENT_GONE
// refund, a core hold and the abandoned job's hold. The order goes to NEEDS_REVIEW (ADAPTER_ERROR)
// instead, nothing is refunded and nothing is signed; the owner decides (MANUAL FAILED refunds).
// The earlier payout's rows are made with the guards off (tests only), as the TON module leaves them.

const t = useFulfillE2e();
const hex64 = () => randomBytes(32).toString('hex');
const SEQNO_HELD = {
  late: { from: 'EXPIRED', outcome: 'SEQNO_HELD', via: 'SCAN', txHash: hex64(), txLt: '7' },
};

/** Attempt 1 FAILED, its transfer EXPIRED on a throw-away wallet; `late` puts the fact on it. */
async function firstPayout(orderId: string, late: boolean, attemptNo = 1): Promise<void> {
  await t.db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    const attempt = await tx.fulfillmentAttempt.create({
      data: {
        orderId,
        attemptNo,
        adapter: 'FRAGMENT',
        status: 'FAILED',
        request: {},
        ...(late ? { response: { ton: SEQNO_HELD } } : {}),
      },
      select: { id: true },
    });
    await tx.tonTransfer.create({
      data: {
        purpose: 'ORDER',
        attemptId: attempt.id,
        network: 'testnet',
        walletAddress: `0:${hex64()}`,
        seqno: 1,
        validUntil: new Date(Date.now() - 3_600_000),
        toAddress: `0:${hex64()}`,
        amountNanoTon: 1_000_000n,
        payloadHash: hex64(),
        extMsgHash: hex64(),
        bocBase64: 'te6cckE=',
        status: 'EXPIRED',
      },
    });
  });
}

/** NEEDS_REVIEW (ADAPTER_ERROR), the PURCHASE untouched, no attempt added, nothing signed. */
async function expectReviewed(orderId: string): Promise<void> {
  expect(await orderRow(t.db, orderId)).toEqual(
    expect.objectContaining({ status: 'NEEDS_REVIEW', statusReason: 'ADAPTER_ERROR' }),
  );
  expect((await ledgerOf(t.db, orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
  expect((await attemptsOf(t.db, orderId)).map((a) => a.status)).toEqual(['FAILED']);
  expect(await t.db.orderEvent.count({ where: { orderId, to: { in: ['FAILED', 'HELD'] } } })).toBe(
    0,
  );
  expect(await t.hasJob({ kind: 'OWNER_ALERT', alert: 'needsReview', refId: orderId })).toBe(true);
  expect(t.gateway.callCount('sendBoc')).toBe(0);
  expect(t.executedOnChain()).toBe(0);
}

describe('the second run beside a first payout found late (S9f, owner 2026-11-18)', () => {
  it('RECIPIENT_GONE: no refund, NEEDS_REVIEW; the same order without the fact is refunded', async () => {
    const late = await t.order({ providerRef: null });
    await firstPayout(late.orderId, true);
    await expect(t.main.service.run(late.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    await expectReviewed(late.orderId);

    const clean = await t.order({ providerRef: null });
    await firstPayout(clean.orderId, false);
    await expect(t.main.service.run(clean.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect(await orderRow(t.db, clean.orderId)).toEqual(
      expect.objectContaining({ status: 'REFUNDED', statusReason: 'RECIPIENT_GONE' }),
    );
    expect((await ledgerOf(t.db, clean.orderId)).map((l) => l.kind)).toEqual([
      'PURCHASE',
      'REFUND',
    ]);
  });

  it('a core hold (NO_ADAPTER): never HELD beside it, NEEDS_REVIEW; without the fact HELD', async () => {
    const late = await t.order({ noRoute: true });
    await firstPayout(late.orderId, true);
    await expect(t.main.service.run(late.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    await expectReviewed(late.orderId);

    const clean = await t.order({ noRoute: true });
    await firstPayout(clean.orderId, false);
    await t.main.service.run(clean.orderId, { finalAttempt: false });
    expect(await orderRow(t.db, clean.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'NO_ADAPTER' }),
    );
  });

  it('the abandoned job (PROCESSING, nothing live): REVIEW instead of the core hold', async () => {
    const fixture = await t.order();
    await firstPayout(fixture.orderId, true);
    await t.db.$transaction(async (tx) => {
      await transitionOrder(tx, {
        orderId: fixture.orderId,
        from: 'PAID',
        to: 'QUEUED',
        actor: 'system',
      });
      await transitionOrder(tx, {
        orderId: fixture.orderId,
        from: 'QUEUED',
        to: 'PROCESSING',
        actor: 'system',
      });
    });
    await expect(t.main.service.settleAbandoned(fixture.orderId)).resolves.toBe('REVIEW');
    await expectReviewed(fixture.orderId);
  });

  it('CR m1: NOT_SENT on the last retry while a late fact appears: NEEDS_REVIEW, never HELD', async () => {
    // The late fact lands on another payout of the order between pay() and the core's hold.
    const payer: TonPayer = {
      pay: async (request: TonPayRequest): Promise<TonPayResult> => {
        await firstPayout(request.orderId, true, 9);
        return { status: 'NOT_SENT', reason: 'WALLET_BUSY' };
      },
    };
    const main = await t.boot({ payer });
    const fixture = await t.order();
    await expect(main.service.run(fixture.orderId, { finalAttempt: true })).resolves.toBe('DONE');
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'NEEDS_REVIEW', statusReason: 'ADAPTER_ERROR' }),
    );
    // The core's attempt (no transfer) goes UNKNOWN with the order; the late one stays FAILED.
    const attempts = await attemptsOf(t.db, fixture.orderId);
    expect(attempts.map((a) => a.status).sort()).toEqual(['FAILED', 'UNKNOWN']);
    expect((await ledgerOf(t.db, fixture.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
    const held = { orderId: fixture.orderId, to: 'HELD' as const };
    expect(await t.db.orderEvent.count({ where: held })).toBe(0);
    const review = { kind: 'OWNER_ALERT', alert: 'needsReview', refId: fixture.orderId } as const;
    expect(await t.hasJob(review)).toBe(true);
  });
});
