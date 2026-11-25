import type { TonPayRequest, TonPayResult } from '../../ton/ton-payout';
import type { TonPayer } from '../fulfill-tokens';
import { attemptsOf, ledgerOf, orderRow } from './fulfill-e2e.fixtures';
import { useFulfillE2e } from './fulfill-e2e.harness';

// What the core decides from each pay() result the chain cannot easily be scripted into (the TON
// module's own e2e suites prove when it gives them): a stand-in payer answers, the core and the
// database guards do the rest. Also a supplier's NOT_SENT, which the core never acts on alone.

const t = useFulfillE2e();

class ScriptedPayer implements TonPayer {
  readonly calls: TonPayRequest[] = [];

  constructor(private readonly answer: (request: TonPayRequest) => Promise<TonPayResult>) {}

  pay(request: TonPayRequest): Promise<TonPayResult> {
    this.calls.push(request);
    return this.answer(request);
  }
}

describe('fulfill-order: the core after each TON payout result', () => {
  it('EXPIRED twice: a second attempt, then HELD (ADAPTER_ERROR) instead of a third', async () => {
    // What the TON module does on EXPIRED: the attempt FAILED (TON_EXPIRED), the order PROCESSING.
    const payer = new ScriptedPayer(async (request) => {
      await t.db.fulfillmentAttempt.update({
        where: { id: request.attemptId },
        data: { status: 'FAILED', error: 'TON_EXPIRED' },
      });
      return { status: 'EXPIRED', transferId: 'none' };
    });
    const main = await t.boot({ payer });
    const fixture = await t.order();
    await expect(main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect(payer.calls).toHaveLength(2);
    expect(new Set(payer.calls.map((c) => c.attemptId)).size).toBe(2);
    expect((await attemptsOf(t.db, fixture.orderId)).map((a) => a.error)).toEqual([
      'TON_EXPIRED',
      'TON_EXPIRED',
    ]);
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'ADAPTER_ERROR' }),
    );
  });

  it('pay() throws (unknown): retried with the SAME attempt; on the last retry NEEDS_REVIEW', async () => {
    const payer = new ScriptedPayer(() => Promise.reject(new Error('redis went away')));
    const main = await t.boot({ payer });
    const fixture = await t.order();
    await expect(main.service.run(fixture.orderId, { finalAttempt: false })).rejects.toThrow(
      'redis went away',
    );
    await expect(main.service.run(fixture.orderId, { finalAttempt: true })).resolves.toBe('DONE');
    expect(new Set(payer.calls.map((c) => c.attemptId)).size).toBe(1);
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'NEEDS_REVIEW', statusReason: 'ADAPTER_ERROR' }),
    );
    expect((await attemptsOf(t.db, fixture.orderId)).map((a) => a.status)).toEqual(['UNKNOWN']);
    expect(
      await t.hasJob({ kind: 'OWNER_ALERT', alert: 'needsReview', refId: fixture.orderId }),
    ).toBe(true);
  });

  it('NOT_SENT: retried later; on the last retry the attempt FAILS and the order is HELD', async () => {
    const payer = new ScriptedPayer(() =>
      Promise.resolve({ status: 'NOT_SENT', reason: 'WALLET_BUSY' }),
    );
    const main = await t.boot({ payer });
    const fixture = await t.order();
    await expect(main.service.run(fixture.orderId, { finalAttempt: false })).rejects.toThrow(
      'TON WALLET_BUSY',
    );
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('PROCESSING');
    await expect(main.service.run(fixture.orderId, { finalAttempt: true })).resolves.toBe('DONE');
    const [attempt] = await attemptsOf(t.db, fixture.orderId);
    expect(attempt).toEqual(
      expect.objectContaining({ status: 'FAILED', error: 'TON_NOT_SENT_WALLET_BUSY' }),
    );
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'ADAPTER_ERROR' }),
    );
    const ref = `${fixture.orderId}_${attempt?.id ?? ''}`;
    expect(await t.hasJob({ kind: 'OWNER_ALERT', alert: 'held', refId: ref })).toBe(true);
    // The replay names the same hold (same alert id) without calling pay() (CR m3).
    const calls = payer.calls.length;
    await t.dropJob({ kind: 'OWNER_ALERT', alert: 'held', refId: ref });
    await expect(main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'REPLAYED',
    );
    expect(payer.calls).toHaveLength(calls);
    expect(await t.hasJob({ kind: 'OWNER_ALERT', alert: 'held', refId: ref })).toBe(true);
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(1);
  });

  it('STOPPED because the order left PROCESSING: nothing more is done', async () => {
    const payer = new ScriptedPayer(() =>
      Promise.resolve({ status: 'STOPPED', reason: 'ORDER_NOT_PROCESSING' }),
    );
    const main = await t.boot({ payer });
    const fixture = await t.order();
    await expect(main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect((await attemptsOf(t.db, fixture.orderId)).map((a) => a.status)).toEqual(['SENDING']);
  });
});

describe('fulfill-order: a supplier NOT_SENT is never acted on by the core alone (CR M2)', () => {
  it('a MANUAL proof from the adapter: one send, attempt UNKNOWN, NEEDS_REVIEW, no refund', async () => {
    const fixture = await t.order({ adapter: 'RESELLER_STARS' });
    t.script.set(fixture.orderId, 'NOT_SENT');
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'DONE',
    );
    const attempts = await attemptsOf(t.db, fixture.orderId);
    expect(attempts.map((a) => [a.status, a.externalRef])).toEqual([
      ['UNKNOWN', `sim-${fixture.orderId}`],
    ]);
    expect(attempts[0]?.response).toEqual({
      supplier: { send: 'NOT_SENT_UNPROVEN', proofKind: 'MANUAL' },
    });
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'NEEDS_REVIEW', statusReason: 'ADAPTER_ERROR' }),
    );
    expect((await ledgerOf(t.db, fixture.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
    expect(
      await t.hasJob({ kind: 'OWNER_ALERT', alert: 'needsReview', refId: fixture.orderId }),
    ).toBe(true);
  });
});
