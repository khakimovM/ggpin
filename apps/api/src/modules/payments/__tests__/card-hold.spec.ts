import { cardReservedHighRef } from '@repo/shared';
import { capacityHoldEnd, reservedShareHigh, reservedSharePercent } from '../card-capacity';
import type { CardPoolRepository, CardTotals } from '../card-pool.repository';
import { CardReservedAlert } from '../card-reserved-alert';
import type { PaymentsAlerts } from '../payments-alerts';
import { isDatabaseBusy, isLockNotAvailable } from '../db-errors';
import { totals } from './payments.fixtures';

const EXPIRES = new Date('2026-11-05T10:30:00.000Z');
const RESERVED = new Date('2026-11-06T10:30:00.000Z');
const HOUR = 3_600;

describe('capacity hold of an unpaid request (D-42 (1))', () => {
  const held = (status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED') =>
    capacityHoldEnd({ status, expiresAt: EXPIRES, reservedUntil: RESERVED }, HOUR);

  it('PAID never counts as reserved (its money is received)', () => {
    expect(held('PAID')).toBeNull();
  });

  it('every unpaid one (PENDING, EXPIRED, CANCELLED) counts until expiresAt + hold: one predicate (R-1)', () => {
    // An overdue PENDING the sweep has not expired yet stops counting exactly like an EXPIRED one.
    expect(held('PENDING')?.toISOString()).toBe('2026-11-05T11:30:00.000Z');
    expect(held('EXPIRED')?.toISOString()).toBe('2026-11-05T11:30:00.000Z');
    expect(held('CANCELLED')?.toISOString()).toBe('2026-11-05T11:30:00.000Z');
  });

  it('never past reservedUntil: a hold longer than the grace is cut at the reservation end', () => {
    const shortReservation = new Date(EXPIRES.getTime() + 600_000);
    const end = capacityHoldEnd(
      { status: 'CANCELLED', expiresAt: EXPIRES, reservedUntil: shortReservation },
      HOUR,
    );
    expect(end).toEqual(shortReservation);
    // Exactly equal ends are the same moment either way.
    const equal = new Date(EXPIRES.getTime() + HOUR * 1000);
    expect(
      capacityHoldEnd({ status: 'EXPIRED', expiresAt: EXPIRES, reservedUntil: equal }, HOUR),
    ).toEqual(equal);
  });
});

describe('reserved share alert condition (D-42 (1))', () => {
  it('is high only when reserved is MORE than half of the remaining limit', () => {
    const at = (reservedTiyin: bigint) =>
      reservedShareHigh(
        totals({ receiveLimitTiyin: 1_000n }, { receivedTiyin: 200n, reservedTiyin }),
      );
    expect(at(400n)).toBe(false); // exactly 50% of the 800 left
    expect(at(401n)).toBe(true);
    expect(at(0n)).toBe(false);
  });

  it('uses the smaller of the lifetime and the monthly remainder', () => {
    const card = totals(
      { receiveLimitTiyin: 10_000n, monthlyLimitTiyin: 1_000n },
      { receivedTiyin: 2_000n, receivedMonthTiyin: 600n, reservedTiyin: 201n },
    );
    expect(reservedShareHigh(card)).toBe(true); // 201 > 400 / 2
  });

  it('a card with nothing left is high when anything is reserved', () => {
    const full = (reservedTiyin: bigint) =>
      reservedShareHigh(
        totals({ receiveLimitTiyin: 100n }, { receivedTiyin: 100n, reservedTiyin }),
      );
    expect(full(1n)).toBe(true);
    expect(full(0n)).toBe(false);
  });
});

describe('busy shapes (recorded on the test database)', () => {
  const cause = (originalCode: string) => ({
    code: 'P2010',
    meta: { driverAdapterError: { cause: { originalCode } } },
  });

  it('a busy CARD is lock_timeout (55P03) only: the allocator tries the next card', () => {
    expect(isLockNotAvailable(cause('55P03'))).toBe(true);
    expect(isDatabaseBusy(cause('55P03'))).toBe(false);
    for (const other of [{ code: 'P2028' }, { code: 'P2024' }, cause('23505'), null]) {
      expect(isLockNotAvailable(other)).toBe(false);
    }
  });

  it('a busy DATABASE is a transaction (P2028) or pool (P2024) timeout: 503 at once', () => {
    expect(isDatabaseBusy({ code: 'P2028' })).toBe(true);
    expect(isDatabaseBusy({ code: 'P2024' })).toBe(true);
  });

  it('anything else is neither (it is rethrown and stays a 500)', () => {
    expect(isDatabaseBusy(cause('23505'))).toBe(false);
    expect(isDatabaseBusy({ code: 'P2002' })).toBe(false);
    expect(isDatabaseBusy(new Error('connection reset'))).toBe(false);
    expect(isDatabaseBusy(null)).toBe(false);
  });
});

describe('reservedSharePercent (the alert text)', () => {
  it('a whole number, rounded down; nothing left is 100', () => {
    const at = (reservedTiyin: bigint, receivedTiyin = 0n) =>
      reservedSharePercent(totals({ receiveLimitTiyin: 3_000n }, { receivedTiyin, reservedTiyin }));
    expect(at(2_000n)).toBe(66);
    expect(at(1_500n)).toBe(50);
    expect(at(0n)).toBe(0);
    expect(at(1n, 3_000n)).toBe(100);
  });
});

describe('CardReservedAlert.checkAfterCreate (D-42 (1))', () => {
  const NOW = new Date('2026-11-05T10:15:00.000Z');

  function setup(rows: CardTotals[] | Error) {
    const pool = {
      client: { client: true },
      cardTotals: jest.fn(() =>
        rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
      ),
    };
    const alerts = { raise: jest.fn(() => Promise.resolve('job')) };
    const check = new CardReservedAlert(
      pool as unknown as CardPoolRepository,
      alerts as unknown as PaymentsAlerts,
    );
    return { check, pool, alerts };
  }

  it('over half reserved: one cardReservedHigh with the hourly ref of that card', async () => {
    const { check, pool, alerts } = setup([
      totals({ id: 'card_1', receiveLimitTiyin: 1_000n }, { reservedTiyin: 501n }),
    ]);
    await check.checkAfterCreate('card_1', NOW);
    expect(pool.cardTotals.mock.calls[0]).toEqual([
      pool.client,
      expect.objectContaining({ cardId: 'card_1', now: NOW, autoCreditOnly: false }),
    ]);
    expect(alerts.raise).toHaveBeenCalledWith(
      'cardReservedHigh',
      cardReservedHighRef('card_1', NOW),
    );
  });

  it('at or under half, or a card not found: no alert', async () => {
    for (const rows of [
      [totals({ id: 'card_1', receiveLimitTiyin: 1_000n }, { reservedTiyin: 500n })],
      [],
    ]) {
      const { check, alerts } = setup(rows);
      await check.checkAfterCreate('card_1', NOW);
      expect(alerts.raise).not.toHaveBeenCalled();
    }
  });

  it('a database error is swallowed (best effort): the request is already committed', async () => {
    const { check, alerts } = setup(new Error('connection reset'));
    await expect(check.checkAfterCreate('card_1', NOW)).resolves.toBeUndefined();
    expect(alerts.raise).not.toHaveBeenCalled();
  });
});
