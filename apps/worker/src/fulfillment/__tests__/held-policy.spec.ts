import {
  ATTEMPT_HOLD_ERRORS,
  canTransition,
  coreHoldNote,
  isAttemptHoldError,
  notifyJobSchema,
} from '@repo/shared';
import { noticeJob } from '../../ton/ton-notices';
import type { HoldError } from '../../ton/ton-sign-guards';
import {
  NOT_SENT_HOLD_NOTE,
  holdNotices,
  isCoreHold,
  noPurchaseNotice,
  reviewNotices,
} from '../held-policy';

const ORDER = 'cm9orderid000000000000001';
const HOLD = 'cm9eventid000000000000001';

describe('held policy: which hold, which alert id', () => {
  it('a core hold is recognised by its note; S5 and the not-sent hold are attempt holds', () => {
    expect(isCoreHold(coreHoldNote('PRICE_ABOVE_MAX', 'cost above maxCost'))).toBe(true);
    expect(isCoreHold('ton: refused before signing')).toBe(false);
    expect(isCoreHold(NOT_SENT_HOLD_NOTE)).toBe(false);
    expect(isCoreHold(null)).toBe(false);
  });

  it('attempt hold errors: S5 refusals and TON_NOT_SENT_*, never TON_EXPIRED or NOT_SENT', () => {
    for (const error of [
      'LIMIT_PER_ORDER',
      'LIMIT_DAILY',
      'LOW_BALANCE',
      'PAY_ADDRESS_NOT_ALLOWED',
    ]) {
      expect(isAttemptHoldError(error)).toBe(true);
    }
    expect(isAttemptHoldError('TON_NOT_SENT_WALLET_BUSY')).toBe(true);
    expect(isAttemptHoldError('TON_EXPIRED')).toBe(false);
    expect(isAttemptHoldError('NOT_SENT')).toBe(false);
    expect(isAttemptHoldError(null)).toBe(false);
  });

  it('CR L4 / audit L-5: the shared hold errors are exactly the ones the TON module writes', () => {
    // HoldError also carries 'ADAPTER_ERROR' (via TonHoldReason, the ORDER reason a payee refusal
    // maps to): no call site writes it as an attempt `error`, and if one did, that attempt would
    // COUNT against the cap (fail-closed: held sooner, never paid twice).
    type WrittenHoldError = Exclude<HoldError, 'ADAPTER_ERROR'>;
    // Type level, both ways: the Record needs every HoldError written; the array may hold no other.
    const everyWritten: Record<WrittenHoldError, true> = {
      LIMIT_PER_ORDER: true,
      LIMIT_DAILY: true,
      LOW_BALANCE: true,
      PAY_ADDRESS_NOT_ALLOWED: true,
    };
    const shared: readonly WrittenHoldError[] = ATTEMPT_HOLD_ERRORS;
    // Value level: the same set.
    expect([...shared].sort()).toEqual(Object.keys(everyWritten).sort());
    expect(new Set(shared).size).toBe(shared.length);
    expect(isAttemptHoldError('ADAPTER_ERROR')).toBe(false);
  });

  it('a hold tells the customer once per order and the owner per hold (composite refId)', () => {
    const jobs = holdNotices(ORDER, HOLD, 'PRICE_ABOVE_MAX').map(noticeJob);
    expect(jobs).toEqual([
      { kind: 'ORDER_REVIEW', refId: ORDER },
      { kind: 'OWNER_ALERT', alert: 'held', refId: `${ORDER}_${HOLD}` },
    ]);
    for (const job of jobs) expect(notifyJobSchema.safeParse(job).success).toBe(true);
    expect(holdNotices(ORDER, HOLD, 'LIMIT_DAILY').map(noticeJob)).toContainEqual({
      kind: 'OWNER_ALERT',
      alert: 'tonDailyLimit',
      refId: `${ORDER}_${HOLD}`,
    });
  });

  it('NO_PURCHASE: one critical owner alert per order (refId = the order id)', () => {
    const job = noticeJob(noPurchaseNotice(ORDER));
    expect(job).toEqual({ kind: 'OWNER_ALERT', alert: 'orderNoPurchase', refId: ORDER });
    expect(notifyJobSchema.safeParse(job).success).toBe(true);
  });

  it('an unknown outcome: the customer and the owner hear about the order', () => {
    expect(reviewNotices(ORDER).map(noticeJob)).toEqual([
      { kind: 'ORDER_REVIEW', refId: ORDER },
      { kind: 'OWNER_ALERT', alert: 'needsReview', refId: ORDER },
    ]);
  });
});

// The edges the core writes (as `system`) and the ones it must never be able to write.
describe('order state machine as the core uses it', () => {
  it.each([
    ['PAID', 'QUEUED'],
    ['QUEUED', 'PROCESSING'],
    ['PROCESSING', 'DELIVERED'],
    ['PROCESSING', 'HELD'],
    ['PROCESSING', 'NEEDS_REVIEW'],
    ['PROCESSING', 'FAILED'],
    ['FAILED', 'REFUNDED'],
  ] as const)('system may move %s -> %s', (from, to) => {
    expect(canTransition(from, to, 'system')).toBe(true);
  });

  it.each([
    ['PROCESSING', 'QUEUED'],
    ['NEEDS_REVIEW', 'FAILED'],
    ['NEEDS_REVIEW', 'DELIVERED'],
    ['DELIVERED', 'REFUNDED'],
    ['PAID', 'PROCESSING'],
    ['HELD', 'CANCELLED'],
  ] as const)('system may never move %s -> %s', (from, to) => {
    expect(canTransition(from, to, 'system')).toBe(false);
  });
});
