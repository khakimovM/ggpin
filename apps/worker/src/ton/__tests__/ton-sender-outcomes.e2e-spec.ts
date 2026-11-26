import { payRequest, rowsOf, transfersOf } from './ton-e2e.fixtures';
import { PAST_VALID_SEC, SIGN_AT_SEC, pinChain, useTonE2e } from './ton-e2e.harness';

// The death points of a payout (plan 6.5, docs/06 "Yuborishdan keyin", rules/45 step 7) on the real
// database: a signed message is broadcast at most once and NEVER again, not by a replay and not
// by the next attempt; EXPIRED is written only when the chain proves it (seqno unchanged, message
// not found, chain time past valid_until + margin) and the database clock agrees.

const t = useTonE2e();

const movePastValidity = () => {
  pinChain(t.gateway, PAST_VALID_SEC);
  return Promise.resolve();
};

describe('TON payout: death points and EXPIRED (plan 6.5)', () => {
  it('died after the SIGNED commit: the retry follows that message, never broadcasts it; the next attempt signs anew', async () => {
    pinChain(t.gateway, SIGN_AT_SEC);
    const fixture = await t.order();
    const request = payRequest(fixture);
    t.ton.hooks.afterStoredFn = () => Promise.reject(new Error('the worker died here'));
    await expect(t.ton.sender.pay(request)).rejects.toThrow('the worker died here');
    const died = await rowsOf(t.db, fixture);
    expect(died.transfer?.status).toBe('SIGNED');
    expect(died.attempt).toMatchObject({
      status: 'SENDING',
      externalRef: died.transfer?.extMsgHash,
    });
    // The job runs again in another worker, after valid_until: it only looks, then EXPIRED.
    const retry = await t.boot({ wallet: t.wallet, gateway: t.gateway });
    pinChain(t.gateway, PAST_VALID_SEC);
    expect(await retry.sender.pay(request)).toEqual({
      status: 'EXPIRED',
      transferId: died.transfer?.id,
    });
    expect(t.gateway.callCount('sendBoc')).toBe(0);
    const expired = await rowsOf(t.db, fixture);
    expect(expired.transfer?.status).toBe('EXPIRED');
    expect(expired.attempt).toMatchObject({ status: 'FAILED', error: 'TON_EXPIRED' });
    expect(expired.order.status).toBe('PROCESSING');
    // The fulfillment core's next attempt: a new message for the same seqno, never the old BOC.
    const next = await t.attempt(fixture, 2);
    const paid = await retry.sender.pay(payRequest(next, { toAddress: request.toAddress }));
    expect(paid.status).toBe('DELIVERED');
    const rows = await transfersOf(t.db, t.wallet.rawAddress);
    const old = rows.find((r) => r.attemptId === fixture.attemptId);
    const fresh = rows.find((r) => r.attemptId === next.attemptId);
    expect(rows).toHaveLength(2);
    expect([old?.status, fresh?.status]).toEqual(['EXPIRED', 'CONFIRMED']);
    expect(fresh?.seqno).toBe(old?.seqno);
    expect(fresh?.extMsgHash).not.toBe(old?.extMsgHash);
    expect(t.gateway.sentBocs.map((boc) => boc.toString('base64'))).toEqual([fresh?.bocBase64]);
    expect((await rowsOf(t.db, next)).order.status).toBe('DELIVERED');
  });

  it('lost on the way: EXPIRED; a replay sends nothing; the next attempt is a different message', async () => {
    pinChain(t.gateway, SIGN_AT_SEC);
    t.gateway.nextSend('LOSE');
    t.ton.hooks.afterBroadcastFn = movePastValidity;
    const fixture = await t.order();
    const request = payRequest(fixture);
    const lost = await t.ton.sender.pay(request);
    expect(lost.status).toBe('EXPIRED');
    expect(await t.ton.sender.pay(request)).toEqual(lost);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    const lostRows = await rowsOf(t.db, fixture);
    expect(lostRows.transfer?.status).toBe('EXPIRED');
    expect(lostRows.attempt.status).toBe('FAILED');
    t.ton.hooks.afterBroadcastFn = () => Promise.resolve();
    const next = await t.attempt(fixture, 2);
    expect((await t.ton.sender.pay(payRequest(next))).status).toBe('DELIVERED');
    const [first, second] = t.gateway.sentBocs;
    expect(t.gateway.sentBocs).toHaveLength(2);
    expect(first?.equals(second ?? Buffer.alloc(0))).toBe(false);
    expect(first?.toString('base64')).toBe(lostRows.transfer?.bocBase64);
    // EXPIRED tells nobody (the core decides what follows); the delivery is told once.
    await t.expectJobs([{ kind: 'ORDER_DELIVERED', orderId: fixture.orderId }]);
    await t.expectNoJob({ kind: 'ORDER_REVIEW', orderId: fixture.orderId });
  });

  it('a broadcast that failed stays SIGNED (not "not sent"), and is EXPIRED only by the chain proof', async () => {
    pinChain(t.gateway, SIGN_AT_SEC);
    t.gateway.nextSend('THROW');
    const fixture = await t.order();
    const seen: unknown[] = [];
    t.ton.hooks.afterBroadcastFn = async () => {
      const rows = await rowsOf(t.db, fixture);
      seen.push([rows.transfer?.status, rows.attempt.status]);
      pinChain(t.gateway, PAST_VALID_SEC);
    };
    const result = await t.ton.sender.pay(payRequest(fixture));
    expect(seen).toEqual([['SIGNED', 'SENDING']]);
    expect(result.status).toBe('EXPIRED');
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('EXPIRED');
    expect(rows.attempt).toMatchObject({ status: 'FAILED', error: 'TON_EXPIRED' });
  });

  it('the chain alone past valid_until is not enough: no EXPIRED while the database clock is behind', async () => {
    // Chain at now - 30 s: valid_until = now + 30 s, so the database refuses EXPIRED for 90 s.
    pinChain(t.gateway, -30);
    t.gateway.nextSend('LOSE');
    const ton = await t.boot({
      wallet: t.wallet,
      gateway: t.gateway,
      timing: { confirmTimeoutMs: 1_500 },
    });
    ton.hooks.afterBroadcastFn = () => {
      t.gateway.advance(200); // the chain alone is far past valid_until + margin
      return Promise.resolve();
    };
    const fixture = await t.order();
    const result = await ton.sender.pay(payRequest(fixture));
    expect(result).toMatchObject({
      status: 'REVIEW',
      orderStatus: 'NEEDS_REVIEW',
      transferStatus: 'BROADCAST',
    });
    const rows = await rowsOf(t.db, fixture);
    expect(rows.order.statusReason).toBe('CONFIRM_TIMEOUT');
    expect(rows.attempt.status).toBe('UNKNOWN');
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('the network took it but the call failed: found by its hash, DELIVERED, broadcast exactly once', async () => {
    t.gateway.nextSend('LAND_THEN_THROW');
    const fixture = await t.order();
    const result = await t.ton.sender.pay(payRequest(fixture));
    expect(result.status).toBe('DELIVERED');
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    const rows = await rowsOf(t.db, fixture);
    expect(rows.transfer?.status).toBe('CONFIRMED');
    expect(rows.attempt.status).toBe('CONFIRMED');
    expect(rows.order.status).toBe('DELIVERED');
  });
});
