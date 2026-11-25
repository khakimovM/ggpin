import { Logger } from '@nestjs/common';
import { SimulatedFragmentAdapter } from '../../adapters/simulator/simulated-fragment.adapter';
import { pinChain } from '../../ton/__tests__/ton-e2e.harness';
import { RECIPIENT_REFUSED_NOTE } from '../fulfill-eligibility';
import { PRICE_TIYIN, attemptsOf, ledgerOf, orderRow, timelineOf } from './fulfill-e2e.fixtures';
import { useFulfillE2e } from './fulfill-e2e.harness';

// Phase 6 S1 (owner Q2 = A): Telegram Premium appeared after the quote, so the provider refuses
// the gift at prepare (simulator scenario GOT_PREMIUM -> RECIPIENT_REFUSED). Nothing was sent:
// the order is FAILED + REFUNDED in one transaction, reason RECIPIENT_GONE with a note, exactly
// one REFUND entry keyed ORDER/<orderId>, no attempt, nothing on the chain, the customer hears.

const t = useFulfillE2e();
const run = (orderId: string, final = false) =>
  t.main.service.run(orderId, { finalAttempt: final });

describe('fulfill-order: a recipient refused at prepare (Premium after the quote)', () => {
  it.each(['FRAGMENT', 'RESELLER_STARS'] as const)(
    '%s: FAILED + one REFUND, RECIPIENT_GONE with the note, no attempt, nothing sent',
    async (adapter) => {
      pinChain(t.gateway, 0);
      const fixture = await t.order({ adapter });
      t.script.set(fixture.orderId, 'GOT_PREMIUM');
      await expect(run(fixture.orderId)).resolves.toBe('DONE');

      expect(await orderRow(t.db, fixture.orderId)).toEqual(
        expect.objectContaining({ status: 'REFUNDED', statusReason: 'RECIPIENT_GONE' }),
      );
      expect(await timelineOf(t.db, fixture.orderId)).toEqual([
        'QUEUED',
        'PROCESSING',
        'FAILED',
        'REFUNDED',
      ]);
      const events = await t.db.orderEvent.findMany({
        where: { orderId: fixture.orderId, to: { in: ['FAILED', 'REFUNDED'] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { note: true },
      });
      expect(events.map((e) => e.note)).toEqual([RECIPIENT_REFUSED_NOTE, RECIPIENT_REFUSED_NOTE]);
      const refunds = await t.db.ledgerEntry.findMany({
        where: { refType: 'ORDER', refId: fixture.orderId, kind: 'REFUND' },
        select: { amountTiyin: true, userId: true },
      });
      expect(refunds).toEqual([{ amountTiyin: PRICE_TIYIN, userId: fixture.userId }]);
      expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
      expect(t.executedOnChain()).toBe(0);
      expect(await t.hasJob({ kind: 'ORDER_REFUNDED', refId: fixture.orderId })).toBe(true);

      // A replay (or the last retry) refunds nothing twice.
      await expect(run(fixture.orderId, true)).resolves.toBe('REPLAYED');
      expect(await ledgerOf(t.db, fixture.orderId)).toHaveLength(2);
      expect(t.executedOnChain()).toBe(0);
    },
  );
});

describe('fulfill-order: a recipient refused by another adapter re-check (issuer != adapter)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('REFUSED at the re-check: RECIPIENT_GONE with the note, one REFUND, nothing asked to pay', async () => {
    pinChain(t.gateway, 0);
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const prepare = jest.spyOn(SimulatedFragmentAdapter.prototype, 'prepare');
    jest
      .spyOn(SimulatedFragmentAdapter.prototype, 'validateRecipient')
      .mockResolvedValue({ status: 'REFUSED', reason: 'HAS_PREMIUM' });
    // Priced and routed on FRAGMENT, but the handle was issued by the reseller: FRAGMENT re-checks.
    const fixture = await t.order({ adapter: 'FRAGMENT', issuer: 'RESELLER_STARS' });
    await expect(run(fixture.orderId)).resolves.toBe('DONE');

    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'REFUNDED', statusReason: 'RECIPIENT_GONE' }),
    );
    const notes = await t.db.orderEvent.findMany({
      where: { orderId: fixture.orderId, to: { in: ['FAILED', 'REFUNDED'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { note: true },
    });
    expect(notes.map((e) => e.note)).toEqual([RECIPIENT_REFUSED_NOTE, RECIPIENT_REFUSED_NOTE]);
    const refunds = await t.db.ledgerEntry.count({
      where: { refType: 'ORDER', refId: fixture.orderId, kind: 'REFUND' },
    });
    expect(refunds).toBe(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
    expect(t.executedOnChain()).toBe(0);
    // SA L2: the refund line carries a fixed marker, never a name or a username.
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain(
      `order ${fixture.orderId} failed and refunded: RECIPIENT_GONE (recipient refused)`,
    );
    expect(lines.some((line) => line.includes('another recipient'))).toBe(false);
    expect(lines.join('\n')).not.toMatch(/sim_|user[0-9a-z]{6}/);
  });
});
