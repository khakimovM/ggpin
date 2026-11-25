import { payRequest, rowsOf, type PayoutFixture } from './ton-e2e.fixtures';
import { useTonE2e } from './ton-e2e.harness';
import { falseExpired, lateServiceOf } from './ton-late.e2e-kit';

// S9f audit M-1 on the real database: a late chain fact must block a new payment. Once an earlier
// transfer of the order is not provably unpaid (any state but EXPIRED, or EXPIRED with a `late` /
// `lateDestination` fact), the sign gate stops every later attempt of the order BEFORE anything is
// signed: STOPPED EARLIER_PAYOUT_LIVE, no transfer row, no message, the owner's alert names both.

const t = useTonE2e();

/** The next attempt's payout, to the payee of the first one; what the gate answered. */
async function nextAttempt(fixture: PayoutFixture, toAddress: string) {
  const next = await t.attempt(fixture, 2);
  const sentBefore = t.gateway.callCount('sendBoc');
  const result = await t.ton.sender.pay(payRequest(next, { toAddress }));
  const signed = await t.db.tonTransfer.count({ where: { attemptId: next.attemptId } });
  return { next, result, signed, sent: t.gateway.callCount('sendBoc') - sentBefore };
}

describe('TON sign gate: a late fact blocks a new payment (S9f, audit M-1)', () => {
  it('late CONFIRMED: the next attempt signs nothing, sends nothing, the owner hears', async () => {
    const fixture = await t.order();
    const { request, transferId } = await falseExpired(t.db, t.gateway, t.ton, fixture);
    const late = lateServiceOf(t.ton.moduleRef, t.gateway);
    expect(await late.lateConfirm(transferId)).toEqual({ kind: 'WRITTEN', what: 'LATE_CONFIRMED' });

    const { next, result, signed, sent } = await nextAttempt(fixture, request.toAddress);
    expect(result).toEqual({ status: 'STOPPED', reason: 'EARLIER_PAYOUT_LIVE' });
    expect({ signed, sent }).toEqual({ signed: 0, sent: 0 });
    await t.expectJobs([
      { kind: 'ALERT', alert: 'tonLateConfirmed', refId: `${transferId}_${next.attemptId}` },
    ]);
    const rows = await rowsOf(t.db, next);
    expect(rows.attempt.status).toBe('SENDING');
    expect(rows.order.status).toBe('PROCESSING');
  });

  it('EXPIRED with a late fact (found executed, paid nothing as signed): still no new payment', async () => {
    const fixture = await t.order();
    const { request, transferId } = await falseExpired(t.db, t.gateway, t.ton, fixture);
    // The fact as TonLateRepository keeps it for LATE_SUSPECT; the transfer stays EXPIRED.
    await t.db.fulfillmentAttempt.update({
      where: { id: fixture.attemptId },
      data: { response: { ton: { late: { from: 'EXPIRED', outcome: 'SUSPECT', via: 'SCAN' } } } },
    });
    expect((await rowsOf(t.db, fixture)).transfer?.status).toBe('EXPIRED');

    const { next, result, signed, sent } = await nextAttempt(fixture, request.toAddress);
    expect(result).toEqual({ status: 'STOPPED', reason: 'EARLIER_PAYOUT_LIVE' });
    expect({ signed, sent }).toEqual({ signed: 0, sent: 0 });
    await t.expectJobs([
      { kind: 'ALERT', alert: 'tonLateConfirmed', refId: `${transferId}_${next.attemptId}` },
    ]);
  });

  it('control: an EXPIRED transfer without a late fact does not block the next attempt', async () => {
    const fixture = await t.order();
    const { request } = await falseExpired(t.db, t.gateway, t.ton, fixture);
    const { result, signed } = await nextAttempt(fixture, request.toAddress);
    expect(result.status).not.toBe('STOPPED');
    expect(signed).toBe(1);
  });
});
