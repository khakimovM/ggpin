import { parseMajor } from '@repo/shared';
import { Address } from '@ton/core';
import { FAKE_BOUNCE_COST_NANO } from '../fake-ton.gateway';
import { payRequest, rowsOf } from './ton-e2e.fixtures';
import { useTonE2e } from './ton-e2e.harness';

// Outcomes that are not ours to decide (plan 6.5, docs/06 A1, D-59) on the real database: the order
// goes to NEEDS_REVIEW in the same transaction as the transfer's fate and the facts the owner's
// proof needs; nothing is retried, nothing is refunded, and the owner gets the critical alert.

const t = useTonE2e();
const TON = (major: string): bigint => parseMajor('TON', major);

describe('TON payout: outcomes for review (plan 6.5, D-59)', () => {
  it('the seqno used by a message that is not ours: CONSUMED_UNMATCHED, NEEDS_REVIEW, critical alert', async () => {
    t.ton.hooks.afterStoredFn = () => {
      t.gateway.consumeSeqnoForeign(t.wallet.address);
      return Promise.resolve();
    };
    const fixture = await t.order();
    const result = await t.ton.sender.pay(payRequest(fixture));
    expect(result).toMatchObject({
      status: 'REVIEW',
      orderStatus: 'NEEDS_REVIEW',
      transferStatus: 'CONSUMED_UNMATCHED',
    });
    const { order, attempt, transfer } = await rowsOf(t.db, fixture);
    expect(transfer?.status).toBe('CONSUMED_UNMATCHED');
    expect(transfer?.txHash).toBeNull();
    const walletSeqno = (transfer?.seqno ?? -1) + 1;
    expect(attempt).toMatchObject({
      status: 'UNKNOWN',
      response: { ton: { consumedUnmatched: { walletSeqno } } },
    });
    expect(order).toMatchObject({ status: 'NEEDS_REVIEW', statusReason: 'ADAPTER_ERROR' });
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    await t.expectJobs([
      { kind: 'ORDER_REVIEW', orderId: fixture.orderId },
      { kind: 'ALERT', alert: 'needsReview', refId: fixture.orderId },
      { kind: 'ALERT', alert: 'tonSeqnoUnmatched', refId: transfer?.id ?? '' },
    ]);
  });

  it('the destination refused and the value came back: BOUNCED with its proof on the attempt, tonBounced', async () => {
    const fixture = await t.order();
    const request = payRequest(fixture);
    const payee = Address.parseRaw(request.toAddress);
    t.gateway.destination(payee, 'BOUNCE');
    const before = t.gateway.balanceOf(t.wallet.address);
    const result = await t.ton.sender.pay(request);
    expect(result).toMatchObject({
      status: 'REVIEW',
      orderStatus: 'NEEDS_REVIEW',
      transferStatus: 'BOUNCED',
    });
    const { order, attempt, transfer } = await rowsOf(t.db, fixture);
    expect(transfer?.status).toBe('BOUNCED');
    // The facts must be the chain's own: our transaction, the destination's, the return.
    const hex = (tx: { hash(): Buffer } | undefined) => tx?.hash().toString('hex');
    const ours = t.gateway.transactionsOf(t.wallet.address);
    expect(transfer?.txHash).toBe(hex(ours.at(-2)));
    const returned = request.amountNano - FAKE_BOUNCE_COST_NANO;
    expect(attempt).toMatchObject({
      status: 'UNKNOWN',
      response: {
        ton: {
          bounce: {
            txHash: transfer?.txHash,
            returnTxHash: hex(ours.at(-1)),
            returnedNanoTon: returned.toString(),
            destinationTxHash: hex(t.gateway.transactionsOf(payee).at(-1)),
          },
        },
      },
    });
    expect(order).toMatchObject({ status: 'NEEDS_REVIEW', statusReason: 'ADAPTER_ERROR' });
    expect(t.gateway.balanceOf(payee)).toBe(0n);
    expect(t.gateway.balanceOf(t.wallet.address)).toBeGreaterThan(before - request.amountNano);
    await t.expectJobs([
      { kind: 'ORDER_REVIEW', orderId: fixture.orderId },
      { kind: 'ALERT', alert: 'needsReview', refId: fixture.orderId },
      { kind: 'ALERT', alert: 'tonBounced', refId: transfer?.id ?? '' },
    ]);
  });

  it('the wallet skipped the payout (balance gone after signing): SUSPECT, review, the wallet stays blocked', async () => {
    t.ton.hooks.afterStoredFn = () => {
      t.gateway.setBalance(t.wallet.address, TON('0.01'));
      return Promise.resolve();
    };
    const fixture = await t.order();
    const result = await t.ton.sender.pay(payRequest(fixture));
    expect(result).toMatchObject({
      status: 'REVIEW',
      orderStatus: 'NEEDS_REVIEW',
      transferStatus: 'BROADCAST',
    });
    const { order, attempt, transfer } = await rowsOf(t.db, fixture);
    // Not ONCHAIN_FAILED here: that needs a second, independent source (R2a, the reconciler).
    expect(transfer).toMatchObject({ status: 'BROADCAST', txHash: null });
    expect(attempt).toMatchObject({
      status: 'UNKNOWN',
      response: { ton: { suspect: { detail: 'NO_OUT_MESSAGE' } } },
    });
    expect(order).toMatchObject({ status: 'NEEDS_REVIEW', statusReason: 'ADAPTER_ERROR' });
    // The owner hears that the wallet is blocked by this transfer (review M4), once.
    await t.expectJobs([{ kind: 'ALERT', alert: 'tonWalletBlocked', refId: transfer?.id ?? '' }]);
    // Until S9 decides, nothing else is signed from this wallet.
    t.ton.hooks.afterStoredFn = () => Promise.resolve();
    t.gateway.setBalance(t.wallet.address, TON('100'));
    const next = await t.order();
    expect(await t.ton.sender.pay(payRequest(next))).toEqual({
      status: 'NOT_SENT',
      reason: 'WALLET_BUSY',
    });
    expect((await rowsOf(t.db, next)).attempt).toMatchObject({
      status: 'SENDING',
      externalRef: null,
    });
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('a destination that aborted without a bounce: SUSPECT DESTINATION_ABORTED, review', async () => {
    const fixture = await t.order();
    const request = payRequest(fixture);
    t.gateway.destination(Address.parseRaw(request.toAddress), 'ABORT_NO_BOUNCE');
    const result = await t.ton.sender.pay(request);
    expect(result).toMatchObject({ status: 'REVIEW', orderStatus: 'NEEDS_REVIEW' });
    const { attempt, transfer } = await rowsOf(t.db, fixture);
    expect(transfer?.status).toBe('BROADCAST');
    expect(attempt).toMatchObject({
      status: 'UNKNOWN',
      response: { ton: { suspect: { detail: 'DESTINATION_ABORTED' } } },
    });
  });

  it('no proof in time: CONFIRM_TIMEOUT review; a late landing is recorded but never delivers by itself', async () => {
    const ton = await t.boot({
      wallet: t.wallet,
      gateway: t.gateway,
      timing: { confirmTimeoutMs: 1_500 },
    });
    t.gateway.nextSend('HOLD');
    const fixture = await t.order();
    const result = await ton.sender.pay(payRequest(fixture));
    expect(result).toMatchObject({
      status: 'REVIEW',
      orderStatus: 'NEEDS_REVIEW',
      transferStatus: 'BROADCAST',
    });
    const timedOut = await rowsOf(t.db, fixture);
    expect(timedOut.order).toMatchObject({
      status: 'NEEDS_REVIEW',
      statusReason: 'CONFIRM_TIMEOUT',
    });
    expect(timedOut.attempt).toMatchObject({
      status: 'UNKNOWN',
      response: { ton: { timeout: true } },
    });
    await t.expectJobs([
      { kind: 'ORDER_REVIEW', orderId: fixture.orderId },
      { kind: 'ALERT', alert: 'needsReview', refId: fixture.orderId },
      { kind: 'ALERT', alert: 'tonWalletBlocked', refId: timedOut.transfer?.id ?? '' },
    ]);
    // The held message lands later: the chain fact is written, the order waits for the review.
    t.gateway.releaseHeld();
    const transferId = timedOut.transfer?.id ?? '';
    const late = await ton.confirm.check(transferId);
    expect(late.state).toMatchObject({ transferStatus: 'CONFIRMED', orderStatus: 'NEEDS_REVIEW' });
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    await t.expectNoJob({ kind: 'ORDER_DELIVERED', orderId: fixture.orderId });
  });
});
