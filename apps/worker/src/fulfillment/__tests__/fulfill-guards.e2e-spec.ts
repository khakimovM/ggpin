import { transitionOrder } from '@repo/db';
import { SimulatedFragmentAdapter } from '../../adapters/simulator/simulated-fragment.adapter';
import { simulatedProviderRef } from '../../adapters/simulator/simulator-script';
import type { PrepareContext, PrepareResult } from '../../adapters/fulfillment-adapter';
import { SIGN_AT_SEC, pinChain } from '../../ton/__tests__/ton-e2e.harness';
import { TonTransferRepository } from '../../ton/ton-transfer.repository';
import type { TonPayResult } from '../../ton/ton-payout';
import { AttemptsRepository } from '../attempts.repository';
import { attemptsOf, ledgerOf, orderRow, transfersOf } from './fulfill-e2e.fixtures';
import { useFulfillE2e } from './fulfill-e2e.harness';

// The guards the first round left untested (S4 CR m1, m2, m4, audit L-3, L-4, I-1): each test
// fails when its guard is removed (the reviewers' mutants M1 and mut-ref).

const t = useFulfillE2e();
const NOT_SENT: TonPayResult = { status: 'NOT_SENT', reason: 'WALLET_BUSY' };

afterEach(() => jest.restoreAllMocks());

/** A careless adapter: READY whatever the stored recipient (it re-checks nothing). */
class CarelessFragment extends SimulatedFragmentAdapter {
  prepared = 0;

  override prepare(context: PrepareContext): Promise<PrepareResult> {
    this.prepared += 1;
    const username = context.recipient.fields['username'] ?? 'x';
    const recipient = { ...context.recipient, providerRef: simulatedProviderRef(username) };
    return super.prepare({ ...context, recipient });
  }
}

describe('fulfill-order: guards before and after SENDING', () => {
  it('last-retry NOT_SENT for an attempt that already signed: NEEDS_REVIEW, never HELD', async () => {
    pinChain(t.gateway, SIGN_AT_SEC);
    const fixture = await t.order();
    t.main.tonHooks.afterStoredFn = () => Promise.reject(new Error('died'));
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: false })).rejects.toThrow(
      'died',
    );
    await t.kill(t.main);
    const [transfer] = await transfersOf(t.db, fixture.orderId);
    const second = await t.boot({ payer: { pay: () => Promise.resolve(NOT_SENT) } });
    await expect(second.service.run(fixture.orderId, { finalAttempt: true })).resolves.toBe('DONE');
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'NEEDS_REVIEW', statusReason: 'ADAPTER_ERROR' }),
    );
    expect((await attemptsOf(t.db, fixture.orderId)).map((a) => a.status)).toEqual(['UNKNOWN']);
    // Audit I-1: the core's review of an unresolved transfer tells the owner the wallet waits.
    const orderId = fixture.orderId;
    expect(await t.hasJob({ kind: 'OWNER_ALERT', alert: 'needsReview', refId: orderId })).toBe(
      true,
    );
    const refId = transfer?.id ?? '';
    expect(await t.hasJob({ kind: 'OWNER_ALERT', alert: 'tonWalletBlocked', refId })).toBe(true);
    expect(t.executedOnChain()).toBe(0);
  });

  it('no PURCHASE debit of the paid amount: HELD before any attempt, nothing sent', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    // Only possible with the triggers off (tests only): the debit is not what the order cost.
    await t.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.ledgerEntry.updateMany({
        where: { refType: 'ORDER', refId: fixture.orderId, kind: 'PURCHASE' },
        data: { amountTiyin: -1n },
      });
    });
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'DONE',
    );
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'ADAPTER_ERROR' }),
    );
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
    const event = await t.db.orderEvent.findFirstOrThrow({
      where: { orderId: fixture.orderId, to: 'HELD' },
    });
    expect(event.note).toContain('no matching PURCHASE debit');
    const ref = `${fixture.orderId}_${event.id}`;
    expect(await t.hasJob({ kind: 'OWNER_ALERT', alert: 'held', refId: ref })).toBe(true);
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });

  it.each([null, '', ` ${String.fromCharCode(0xa0)}`])(
    'providerRef %j: refunded by the core itself, even when the adapter would pay',
    async (providerRef) => {
      pinChain(t.gateway, 0);
      const careless = new CarelessFragment(t.env, t.script);
      const main = await t.boot({ adapters: new Map([['FRAGMENT', careless]]) });
      const fixture = await t.order({ providerRef });
      await expect(main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
        'DONE',
      );
      expect(careless.prepared).toBe(0);
      expect(await orderRow(t.db, fixture.orderId)).toEqual(
        expect.objectContaining({ status: 'REFUNDED', statusReason: 'RECIPIENT_GONE' }),
      );
      expect((await ledgerOf(t.db, fixture.orderId)).map((l) => l.kind)).toEqual([
        'PURCHASE',
        'REFUND',
      ]);
      expect(t.gateway.callCount('sendBoc')).toBe(0);
    },
  );

  it('a payee outside FRAGMENT_PAY_ADDRESSES is a core hold before SENDING (audit L-4)', async () => {
    const main = await t.boot({ payAddresses: new Set() });
    const fixture = await t.order();
    await expect(main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'ADAPTER_ERROR' }),
    );
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });
});

describe('fulfill-order: the hold a replay names is the latest attempt (CR m4)', () => {
  it('#1 PAY_ADDRESS_NOT_ALLOWED, released, #2 TON_NOT_SENT: the replay names #2 only', async () => {
    const transfers = t.main.moduleRef.get(TonTransferRepository, { strict: false });
    const first = await t.boot({
      payer: {
        pay: async (request) => {
          await transfers.holdBeforeSigning(
            request.orderId,
            request.attemptId,
            'PAY_ADDRESS_NOT_ALLOWED',
          );
          return { status: 'HELD', reason: 'ADAPTER_ERROR' };
        },
      },
    });
    const fixture = await t.order();
    await first.service.run(fixture.orderId, { finalAttempt: false });
    const [a1] = await attemptsOf(t.db, fixture.orderId);
    expect(await transfers.tonHoldOf(fixture.orderId)).toEqual({
      reason: 'ADAPTER_ERROR',
      attemptId: a1?.id,
    });
    // An operator (or S9) releases the hold; the wallet then stays busy through the last retry.
    await t.db.$transaction((tx) =>
      transitionOrder(tx, {
        orderId: fixture.orderId,
        from: 'HELD',
        to: 'QUEUED',
        actor: 'system',
      }),
    );
    const second = await t.boot({ payer: { pay: () => Promise.resolve(NOT_SENT) } });
    await expect(second.service.run(fixture.orderId, { finalAttempt: true })).resolves.toBe('DONE');
    const [, a2] = await attemptsOf(t.db, fixture.orderId);
    expect(a2).toEqual(expect.objectContaining({ error: 'TON_NOT_SENT_WALLET_BUSY' }));
    expect(await transfers.tonHoldOf(fixture.orderId)).toBeNull();

    const alertOf = (id: string) => ({
      kind: 'OWNER_ALERT' as const,
      alert: 'held' as const,
      refId: `${fixture.orderId}_${id}`,
    });
    await t.dropJob(alertOf(a1?.id ?? ''));
    await t.dropJob(alertOf(a2?.id ?? ''));
    await expect(second.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'REPLAYED',
    );
    expect(await t.hasJob(alertOf(a2?.id ?? ''))).toBe(true);
    expect(await t.hasJob(alertOf(a1?.id ?? ''))).toBe(false);
  });
});

describe('fulfill-order: a refused SENDING row nobody owns', () => {
  it('a refused SENDING row, the order still PROCESSING, no live attempt: HELD + alert (afterStale)', async () => {
    const fixture = await t.order();
    // E.g. the supplier reference of an earlier attempt (keyed by the order id) hit the unique key.
    const attempts = t.main.moduleRef.get(AttemptsRepository);
    jest.spyOn(attempts, 'createSending').mockResolvedValue({ kind: 'STALE' });
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'DONE',
    );
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'ADAPTER_ERROR' }),
    );
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
    const event = await t.db.orderEvent.findFirstOrThrow({
      where: { orderId: fixture.orderId, to: 'HELD' },
    });
    const held = { kind: 'OWNER_ALERT', alert: 'held' } as const;
    expect(await t.hasJob({ ...held, refId: `${fixture.orderId}_${event.id}` })).toBe(true);
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });
});
