import { canTransition, notifyJobSchema } from '@repo/shared';
import { noticeJob } from '../../ton/ton-notices';
import {
  NOT_SENT_HOLD_NOTE,
  coreHoldNote,
  holdNotices,
  isAttemptHoldError,
  isCoreHold,
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
