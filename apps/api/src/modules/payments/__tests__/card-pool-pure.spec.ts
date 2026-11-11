import { reservedUntilAtCreation } from '@repo/shared';
import { isHeartbeatFresh } from '../bank-feed-health';
import { freeCapacity, rankCards, tashkentMonthStart } from '../card-capacity';
import { intentInsertConflict, isUniqueViolation } from '../db-errors';
import { intentExpiresAt } from '../intent-times';
import { totals } from './payments.fixtures';

describe('card capacity (docs/05 §2)', () => {
  it('free = limit - received - reserved; a monthly cap counts this month only and the smaller wins', () => {
    expect(
      freeCapacity(
        totals({ receiveLimitTiyin: 1_000n }, { receivedTiyin: 300n, reservedTiyin: 200n }),
      ),
    ).toBe(500n);
    const monthly = totals(
      { receiveLimitTiyin: 10_000n, monthlyLimitTiyin: 1_000n },
      { receivedTiyin: 5_000n, receivedMonthTiyin: 600n, reservedTiyin: 100n },
    );
    expect(freeCapacity(monthly)).toBe(300n);
    expect(freeCapacity(totals({ receiveLimitTiyin: 100n }, { receivedTiyin: 150n }))).toBe(-50n);
  });

  it('ranks the sticky card first when it fits, then by free capacity, then by id; drops cards that cannot fit', () => {
    const cards = [
      totals({ id: 'c1', receiveLimitTiyin: 1_000n }),
      totals({ id: 'c2', receiveLimitTiyin: 5_000n }),
      totals({ id: 'c3', receiveLimitTiyin: 5_000n }),
      totals({ id: 'c4', receiveLimitTiyin: 50n }),
    ];
    const ids = (sticky: string | null) => rankCards(cards, 100n, sticky).map((t) => t.card.id);
    expect(ids(null)).toEqual(['c2', 'c3', 'c1']);
    expect(ids('c1')).toEqual(['c1', 'c2', 'c3']);
    // A sticky card that cannot take the request is not offered.
    expect(ids('c4')).toEqual(['c2', 'c3', 'c1']);
  });

  it('the month starts at 00:00 Asia/Tashkent (UTC+5), also across the UTC month boundary', () => {
    expect(tashkentMonthStart(new Date('2026-11-15T12:00:00.000Z')).toISOString()).toBe(
      '2026-10-31T19:00:00.000Z',
    );
    // 20:00 UTC on Oct 31 is already Nov 1 in Tashkent.
    expect(tashkentMonthStart(new Date('2026-10-31T20:00:00.000Z')).toISOString()).toBe(
      '2026-10-31T19:00:00.000Z',
    );
    expect(tashkentMonthStart(new Date('2026-10-31T18:59:59.999Z')).toISOString()).toBe(
      '2026-09-30T19:00:00.000Z',
    );
  });
});

describe('intent times', () => {
  it('expiresAt = createdAt + TTL and reservedUntil = expiresAt + grace exactly (the PAID guard reads the gap as the grace)', () => {
    const createdAt = new Date('2026-11-05T10:00:00.000Z');
    const expiresAt = intentExpiresAt(createdAt, 1800);
    expect(expiresAt.toISOString()).toBe('2026-11-05T10:30:00.000Z');
    const reservedUntil = reservedUntilAtCreation(expiresAt, 86_400);
    expect(reservedUntil.toISOString()).toBe('2026-11-06T10:30:00.000Z');
    expect(reservedUntil.getTime() - expiresAt.getTime()).toBe(86_400_000);
  });
});

describe('bank-feed heartbeat', () => {
  const now = new Date('2026-11-05T10:00:00.000Z');
  const ms = (offsetSec: number) => String(now.getTime() + offsetSec * 1000);

  it('is fresh within the max age, in either direction (clock skew)', () => {
    expect(isHeartbeatFresh(ms(-120), now, 120)).toBe(true);
    expect(isHeartbeatFresh(ms(5), now, 120)).toBe(true);
  });

  it('is stale (= listener down) when old, missing, unreadable or far in the future', () => {
    expect(isHeartbeatFresh(ms(-121), now, 120)).toBe(false);
    expect(isHeartbeatFresh(null, now, 120)).toBe(false);
    expect(isHeartbeatFresh('2026-11-05T10:00:00Z', now, 120)).toBe(false);
    expect(isHeartbeatFresh('', now, 120)).toBe(false);
    expect(isHeartbeatFresh(ms(3600), now, 120)).toBe(false);
  });
});

describe('intentInsertConflict (Prisma 7 + pg adapter error shapes)', () => {
  const unique = (index: string) => ({
    code: 'P2002',
    meta: { driverAdapterError: { cause: { originalCode: '23505', constraint: { index } } } },
  });
  const exclusion = (name: string) => ({
    code: 'P2039',
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: '23P01',
          originalMessage: `conflicting key value violates exclusion constraint "${name}"`,
        },
      },
    },
  });

  it('maps the four PaymentIntent rules and nothing else', () => {
    expect(intentInsertConflict(unique('PaymentIntent_card_amount_pending_key'))).toBe(
      'AMOUNT_TAKEN',
    );
    expect(intentInsertConflict(exclusion('PaymentIntent_card_amount_reserved_excl'))).toBe(
      'AMOUNT_TAKEN',
    );
    expect(intentInsertConflict(unique('PaymentIntent_user_pending_p2p_key'))).toBe('USER_PENDING');
    expect(intentInsertConflict(unique('PaymentIntent_userId_idempotencyKey_key'))).toBe(
      'IDEMPOTENCY_KEY',
    );
    expect(intentInsertConflict(unique('PaymentIntent_payTokenHash_key'))).toBeNull();
    expect(intentInsertConflict(exclusion('Other_excl'))).toBeNull();
    expect(intentInsertConflict(new Error('boom'))).toBeNull();
    expect(intentInsertConflict(null)).toBeNull();
    const live = 'TopupCard_bank_last4_active_key';
    expect(isUniqueViolation(unique(live), live)).toBe(true);
    // Another unique index (or an exclusion) is not "last4 taken": it is rethrown as is.
    expect(isUniqueViolation(unique('TopupCard_pan_key'), live)).toBe(false);
    expect(isUniqueViolation(exclusion(live), live)).toBe(false);
    expect(isUniqueViolation(new Error('boom'), live)).toBe(false);
  });
});
