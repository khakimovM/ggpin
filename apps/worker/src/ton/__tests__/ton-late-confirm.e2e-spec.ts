import type { FakeDestinationScenario } from '../fake-ton-state';
import { eventsTo, payRequest, rowsOf, tonFactOf } from './ton-e2e.fixtures';
import { PAST_VALID_SEC, SIGN_AT_SEC, pinChain, useTonE2e } from './ton-e2e.harness';
import {
  falseExpired,
  heldExpiredRefund,
  hex,
  landHeld,
  lateServiceOf,
  ledgerOf,
} from './ton-late.e2e-kit';

// S9f, D-64 (7), audit I-5: a transfer counted EXPIRED whose message reached the chain after all.
// The transfer row records the chain (CONFIRMED with our transaction, the `late` mark); the order
// and the ledger are NOT touched, the owner hears `tonLateConfirmed`. Mainnet gate I-4: this holds
// for the EXPIRED transfer of an order the reconciler refunded (HELD_EXPIRED -> REFUNDED) too.
// The late bounce watch of a CONFIRMED transfer: BOUNCED + NEEDS_REVIEW only for the open attempt
// of the order's one live payout (review F1, its pure rule in ton-late-pure.spec.ts); an
// EXPIRED-then-found transfer's attempt is FAILED, so its bounce is `lateBounce` facts and an alert.
// An aborted destination is a `lateDestination` fact (owner 2026-11-18). A late CONFIRMED that the
// seqno index refuses is kept as a `late` SEQNO_HELD fact: one alert, then the scan of it ends (F3).

const t = useTonE2e();

async function expired(destination: FakeDestinationScenario) {
  const fixture = await t.order();
  const late = lateServiceOf(t.ton.moduleRef, t.gateway);
  const paid = await falseExpired(t.db, t.gateway, t.ton, fixture, destination);
  return { fixture, late, ...paid };
}

describe('TON late facts: EXPIRED found on the chain (S9f)', () => {
  it('CONFIRMED with the late mark; the order, the attempt and the ledger stay; alert; replay is a no-op', async () => {
    const { fixture, late, transferId } = await expired('PROCESS');
    const ledger = await ledgerOf(t.db, fixture.userId);
    const ours = t.gateway.transactionsOf(t.wallet.address).at(-1);
    expect(await late.lateConfirm(transferId)).toEqual({ kind: 'WRITTEN', what: 'LATE_CONFIRMED' });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer).toMatchObject({ status: 'CONFIRMED', txHash: hex(ours), txLt: ours?.lt });
    expect(rows.attempt).toMatchObject({
      status: 'FAILED',
      response: {
        ton: { late: { from: 'EXPIRED', outcome: 'CONFIRMED', via: 'SCAN', txHash: hex(ours) } },
      },
    });
    // Mutant "a late CONFIRMED delivers the order": the order and the ledger must not move.
    expect(rows.order.status).toBe('PROCESSING');
    expect(await eventsTo(t.db, fixture.orderId, 'DELIVERED')).toBe(0);
    expect(await ledgerOf(t.db, fixture.userId)).toEqual(ledger);
    await t.expectJobs([{ kind: 'ALERT', alert: 'tonLateConfirmed', refId: transferId }]);
    await t.expectNoJob({ kind: 'ORDER_DELIVERED', orderId: fixture.orderId });
    expect(await late.lateConfirm(transferId)).toEqual({ kind: 'NOTHING', why: 'NOT_ELIGIBLE' });
    // The destination took the value: the late bounce watch ends there.
    expect(await late.lateBounce(transferId)).toEqual({ kind: 'NOTHING', why: 'PROCESSED' });
    expect(await late.lateBounce(transferId)).toEqual({ kind: 'NOTHING', why: 'SETTLED' });
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('I-4: HELD_EXPIRED -> REFUNDED, paid and bounced after all: CONFIRMED + lateBounce facts, money unmoved', async () => {
    const { fixture, late, transferId } = await expired('BOUNCE');
    await heldExpiredRefund(t.db, fixture);
    const refunded = await ledgerOf(t.db, fixture.userId);
    expect(refunded.map((e) => e.kind)).toEqual(['PURCHASE', 'REFUND']);
    expect(await late.lateConfirm(transferId)).toEqual({ kind: 'WRITTEN', what: 'LATE_CONFIRMED' });
    // Mutant "BOUNCED whatever the order": the guard refuses it on a REFUNDED order (GG001).
    expect(await late.lateBounce(transferId)).toEqual({ kind: 'WRITTEN', what: 'LATE_BOUNCE' });
    const [ours, back] = t.gateway.transactionsOf(t.wallet.address).slice(-2);
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer).toMatchObject({ status: 'CONFIRMED', txHash: hex(ours) });
    expect(rows.attempt.response).toMatchObject({
      ton: {
        late: { from: 'EXPIRED', outcome: 'CONFIRMED' },
        lateBounce: { txHash: hex(ours), returnTxHash: hex(back), orderStatus: 'REFUNDED' },
      },
    });
    expect(rows.order.status).toBe('REFUNDED');
    expect(await ledgerOf(t.db, fixture.userId)).toEqual(refunded);
    await t.expectJobs([
      { kind: 'ALERT', alert: 'tonLateConfirmed', refId: transferId },
      { kind: 'ALERT', alert: 'tonBounced', refId: transferId },
    ]);
    // Another process (nothing kept in memory): the recorded fact stops it, nothing is written.
    const restarted = lateServiceOf(t.ton.moduleRef, t.gateway);
    expect(await restarted.lateBounce(transferId)).toEqual({ kind: 'NOTHING', why: 'ALREADY' });
  });

  it('a PROCESSING order whose late transfer bounced, its attempt dead: facts + alert, the order stays (F1)', async () => {
    const { fixture, late, transferId } = await expired('BOUNCE');
    const ledger = await ledgerOf(t.db, fixture.userId);
    await late.lateConfirm(transferId);
    expect(await late.lateBounce(transferId)).toEqual({ kind: 'WRITTEN', what: 'LATE_BOUNCE' });
    const [ours, back] = t.gateway.transactionsOf(t.wallet.address).slice(-2);
    const rows = await rowsOf(t.db, fixture);
    // Mutant "BOUNCED whatever the attempt": the dead attempt would take the order to review.
    expect(rows.transfer?.status).toBe('CONFIRMED');
    expect(rows.attempt.status).toBe('FAILED');
    expect(rows.attempt.response).toMatchObject({
      ton: {
        lateBounce: { txHash: hex(ours), returnTxHash: hex(back), orderStatus: 'PROCESSING' },
      },
    });
    expect(tonFactOf(rows.attempt.response, 'bounce')).toBeNull();
    expect(rows.order.status).toBe('PROCESSING');
    expect(await ledgerOf(t.db, fixture.userId)).toEqual(ledger);
    await t.expectJobs([{ kind: 'ALERT', alert: 'tonBounced', refId: transferId }]);
    await t.expectNoJob({ kind: 'ORDER_REVIEW', orderId: fixture.orderId });
  });

  it('an aborted destination: the lateDestination fact, written once; nothing else moves (F4)', async () => {
    const { fixture, late, transferId } = await expired('ABORT_NO_BOUNCE');
    const ledger = await ledgerOf(t.db, fixture.userId);
    await late.lateConfirm(transferId);
    expect(await late.lateBounce(transferId)).toEqual({
      kind: 'WRITTEN',
      what: 'LATE_DESTINATION',
    });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('CONFIRMED');
    const fact = tonFactOf(rows.attempt.response, 'lateDestination');
    expect(fact).toMatchObject({ verdict: 'DESTINATION_ABORTED', orderStatus: 'PROCESSING' });
    expect(JSON.stringify(fact)).toMatch(/"destTxHash":"[0-9a-f]{64}"/);
    expect(rows.order.status).toBe('PROCESSING');
    expect(await ledgerOf(t.db, fixture.userId)).toEqual(ledger);
    expect(await late.lateBounce(transferId)).toEqual({ kind: 'NOTHING', why: 'SETTLED' });
    const restarted = lateServiceOf(t.ton.moduleRef, t.gateway);
    expect(await restarted.lateBounce(transferId)).toEqual({ kind: 'NOTHING', why: 'ALREADY' });
  });

  it('a live transfer holds the seqno: refused once, kept as SEQNO_HELD; a hint naming it is OTHER_TRANSFER (F3)', async () => {
    const fixture = await t.order();
    const late = lateServiceOf(t.ton.moduleRef, t.gateway, [t.gateway.freshConnection()]);
    const request = payRequest(fixture);
    pinChain(t.gateway, SIGN_AT_SEC);
    t.gateway.nextSend('HOLD');
    t.ton.hooks.afterBroadcastFn = () => {
      pinChain(t.gateway, PAST_VALID_SEC);
      return Promise.resolve();
    };
    expect((await t.ton.sender.pay(request)).status).toBe('EXPIRED');
    t.ton.hooks.afterBroadcastFn = () => Promise.resolve();
    // The next attempt signs the same seqno; before its broadcast the first message lands.
    const next = await t.attempt(fixture, 2);
    t.ton.hooks.afterStoredFn = () => {
      landHeld(t.gateway);
      return Promise.resolve();
    };
    t.gateway.nextSend('LOSE');
    const second = await t.ton.sender.pay(payRequest(next, { toAddress: request.toAddress }));
    t.ton.hooks.afterStoredFn = () => Promise.resolve();
    expect(second).toMatchObject({ status: 'REVIEW', transferStatus: 'CONSUMED_UNMATCHED' });
    const first = await rowsOf(t.db, fixture);
    const live = await rowsOf(t.db, next);
    const firstId = first.transfer?.id ?? '';
    const liveId = live.transfer?.id ?? '';
    const ledger = await ledgerOf(t.db, fixture.userId);

    expect(await late.lateConfirm(firstId)).toEqual({
      kind: 'REFUSED',
      orderId: fixture.orderId,
      cause: 'UNIQUE',
    });
    const landed = t.gateway.transactionsOf(t.wallet.address).at(-1);
    const held = await rowsOf(t.db, fixture);
    expect(held.transfer?.status).toBe('EXPIRED');
    expect(tonFactOf(held.attempt.response, 'late')).toMatchObject({
      from: 'EXPIRED',
      outcome: 'SEQNO_HELD',
      via: 'SCAN',
      txHash: hex(landed),
    });
    await t.expectJobs([{ kind: 'ALERT', alert: 'tonLateConfirmed', refId: firstId }]);
    // The kept fact ends the late scan of it: no refusal (and no hourly alert) a second time.
    expect(await late.lateConfirm(firstId)).toEqual({ kind: 'NOTHING', why: 'ALREADY' });

    // Z6: the owner names the landed transaction for the live (CONSUMED_UNMATCHED) transfer. It
    // carries the FIRST transfer's message: rejected with that transfer named, no alert (S5's
    // tonSeqnoUnmatched for this seqno is not queued again: dropped here, still absent after).
    const unmatched = { kind: 'ALERT', alert: 'tonSeqnoUnmatched', refId: liveId } as const;
    await t.dropJobs([unmatched]);
    const hint = { auditId: 'audit-hint-p2002', txHash: hex(landed) ?? '', lt: String(landed?.lt) };
    expect(await late.checkHint(liveId, hint)).toEqual({ kind: 'WRITTEN', what: 'HINT_REJECTED' });
    const rejected = await rowsOf(t.db, next);
    expect(rejected.transfer?.status).toBe('CONSUMED_UNMATCHED');
    expect(tonFactOf(rejected.attempt.response, 'hint')).toEqual({
      auditId: hint.auditId,
      verdict: 'REJECTED',
      code: 'OTHER_TRANSFER',
      message: `OTHER_TRANSFER(${firstId})`,
    });
    expect(rejected.order.status).toBe('NEEDS_REVIEW');
    expect(await ledgerOf(t.db, fixture.userId)).toEqual(ledger);
    await t.expectNoJob({ kind: 'ALERT', alert: 'tonLateConfirmed', refId: liveId });
    await t.expectNoJob({ kind: 'ALERT', alert: 'tonBounced', refId: liveId });
    await t.expectNoJob(unmatched);
    expect(t.gateway.sentBocs).toHaveLength(2);
  });
});
