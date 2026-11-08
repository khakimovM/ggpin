import { describe, expect, it } from 'vitest';
import {
  ALERT_KINDS,
  BANK_FEED_ALERT_PARAMS,
  BANK_FEED_SOURCES,
  BANK_OF_SOURCE,
  CARD_BANKS,
  daytimeMinutesBetween,
  isCardSilent,
  PAY_TOKEN_LENGTH,
  PAY_TOKEN_PATTERN,
  REVIEW_ALERT,
  reviewAlertOf,
  REVIEW_KINDS,
  TOPUP_CARD_STATUSES,
  bankMessageJobId,
} from './bank-feed';

describe('bank feed vocabulary', () => {
  it('lists unique values', () => {
    for (const list of [REVIEW_KINDS, ALERT_KINDS, BANK_FEED_SOURCES, CARD_BANKS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('every bot source maps to one bank and every bank has a source', () => {
    expect(Object.keys(BANK_OF_SOURCE).sort()).toEqual([...BANK_FEED_SOURCES].sort());
    expect(Object.values(BANK_OF_SOURCE).sort()).toEqual([...CARD_BANKS].sort());
  });

  it('every review kind raises a known alert, and alert params cover every alert', () => {
    expect(Object.keys(REVIEW_ALERT).sort()).toEqual([...REVIEW_KINDS].sort());
    for (const alert of Object.values(REVIEW_ALERT)) expect(ALERT_KINDS).toContain(alert);
    expect(Object.keys(BANK_FEED_ALERT_PARAMS).sort()).toEqual([...ALERT_KINDS].sort());
  });

  it('has the review kinds and card status of the owner decisions (D-37)', () => {
    for (const kind of ['CANCELLED_LATE', 'DAILY_LIMIT', 'POSSIBLE_REVERSAL', 'USER_BLOCKED']) {
      expect(REVIEW_KINDS).toContain(kind);
    }
    expect(TOPUP_CARD_STATUSES).toEqual(['VERIFYING', 'ACTIVE', 'FULL', 'DRAINING', 'RETIRED']);
    // the unused 'late' alert is gone; DEBITs, silence and owner actions have their own alerts
    expect(ALERT_KINDS).not.toContain('late');
    expect(REVIEW_ALERT.DAILY_LIMIT).toBe('dailyLimit');
    expect(REVIEW_KINDS).not.toContain('NEW_ACCOUNT_LIMIT');
    for (const alert of ['debit', 'cardSilent', 'cardDraining', 'adminAction']) {
      expect(ALERT_KINDS).toContain(alert);
    }
  });

  it('reviewAlertOf: a review on a card with a telling note gets its own alert', () => {
    expect(reviewAlertOf('UNRECOGNIZED', 'TITLE_UNKNOWN', true)).toBe('titleUnknown');
    expect(reviewAlertOf('UNRECOGNIZED', 'SENDER_MISMATCH', true)).toBe('integrityAnomaly');
    expect(reviewAlertOf('UNRECOGNIZED', 'TEXT_HASH_MISMATCH', true)).toBe('integrityAnomaly');
    expect(reviewAlertOf('UNRECOGNIZED', 'PROCESSING_FAILED', true)).toBe('processingFailed');
    expect(reviewAlertOf('AMBIGUOUS', 'AMOUNT_REALLOCATED', true)).toBe('amountReallocated');
    expect(reviewAlertOf('AMBIGUOUS', 'LATE_STORED', true)).toBe('lateStored');
    expect(reviewAlertOf('AMBIGUOUS', 'MANUAL_CREDIT_SEEN', true)).toBe('manualCreditSeen');
    expect(reviewAlertOf('AMBIGUOUS', null, true)).toBe('ambiguous');
    // A note only counts with the kind it belongs to.
    expect(reviewAlertOf('UNRECOGNIZED', 'AMOUNT_REALLOCATED', true)).toBe('unrecognized');
    // Without a card these alerts could not name it: the generic one.
    expect(reviewAlertOf('UNRECOGNIZED', 'PROCESSING_FAILED', false)).toBe('unrecognized');
    expect(reviewAlertOf('UNRECOGNIZED', 'REPARSE_MISMATCH', true)).toBe('unrecognized');
    expect(reviewAlertOf('UNRECOGNIZED', null, true)).toBe('unrecognized');
    expect(reviewAlertOf('NO_MATCH', 'TITLE_UNKNOWN', true)).toBe('noMatch');
  });

  it('every alert is raised by something: a review kind or an operational event', () => {
    const operational = [
      // Review alerts chosen by note (reviewAlertOf), not by kind.
      'titleUnknown',
      'integrityAnomaly',
      'processingFailed',
      'amountReallocated',
      'lateStored',
      'manualCreditSeen',
      // Ingest refused a message of another chat without storing it (no review possible).
      'foreignChat',
      // Matcher failures that leave no review (limit check, a fail-closed write that failed).
      'limitCheckFailed',
      'messageStuck',
      'effectsFailed',
      'edited',
      'cardVerified',
      'cardNearLimit',
      'cardFull',
      'cardReservedHigh',
      'lateOverLimit',
      'listenerDown',
      'sessionRevoked',
      'newAuthorization',
      'reconcileOk',
      'reconcileMismatch',
      'reconcileFailed',
      'walletFrozen',
      'debit',
      'cardSilent',
      'cardDraining',
      'adminAction',
    ];
    const reviewAlerts = Object.values(REVIEW_ALERT);
    expect([...reviewAlerts, ...operational].sort()).toEqual([...ALERT_KINDS].sort());
  });

  it('alert params never include a card number, balance, message text or phone', () => {
    const forbidden = ['pan', 'number', 'cardNumber', 'balance', 'text', 'phone'];
    for (const params of Object.values(BANK_FEED_ALERT_PARAMS)) {
      for (const name of forbidden) expect(params).not.toContain(name);
    }
  });
});

describe('pay token pattern', () => {
  it('is 43 base64url characters', () => {
    expect(PAY_TOKEN_LENGTH).toBe(43);
    expect(PAY_TOKEN_PATTERN.test('A'.repeat(43))).toBe(true);
    expect(PAY_TOKEN_PATTERN.test(`${'a-_9'.repeat(10)}abc`)).toBe(true);
    expect(PAY_TOKEN_PATTERN.test('A'.repeat(42))).toBe(false);
    expect(PAY_TOKEN_PATTERN.test('A'.repeat(44))).toBe(false);
    expect(PAY_TOKEN_PATTERN.test(`${'A'.repeat(42)}=`)).toBe(false);
    expect(PAY_TOKEN_PATTERN.test(`${'A'.repeat(42)}\n`)).toBe(false);
  });
});

describe('bankMessageJobId', () => {
  it('is bm-<id> and refuses an id BullMQ would reject', () => {
    expect(bankMessageJobId('cm0abc123')).toBe('bm-cm0abc123');
    expect(() => bankMessageJobId('a:b')).toThrow();
  });
});

describe('silence detection counts daytime only (Asia/Tashkent 00:00-08:00 is skipped)', () => {
  // Asia/Tashkent is UTC+5: 07:00Z is 12:00 local.
  const at = (iso: string): Date => new Date(iso);

  it('counts every minute of a daytime stretch', () => {
    expect(daytimeMinutesBetween(at('2026-11-04T07:00:00Z'), at('2026-11-04T10:00:00Z'))).toBe(180);
  });

  it('skips the night: 22:00 to 09:00 local is 2 h before midnight and 1 h after 08:00', () => {
    expect(daytimeMinutesBetween(at('2026-11-04T17:00:00Z'), at('2026-11-05T04:00:00Z'))).toBe(180);
  });

  it('a whole night counts nothing', () => {
    expect(daytimeMinutesBetween(at('2026-11-04T19:00:00Z'), at('2026-11-05T03:00:00Z'))).toBe(0);
  });

  it('a year is counted in closed form: 365 days of 16 daytime hours, instantly', () => {
    const started = Date.now();
    const minutes = daytimeMinutesBetween(at('2026-01-01T00:00:00Z'), at('2027-01-01T00:00:00Z'));
    expect(minutes).toBe(365 * 16 * 60);
    expect(Date.now() - started).toBeLessThan(50);
    expect(isCardSilent(at('2026-01-01T00:00:00Z'), at('2027-01-01T00:00:00Z'))).toBe(true);
  });

  it('the closed form agrees with a minute-by-minute count over a mixed range', () => {
    const from = at('2026-11-04T13:37:00Z');
    const to = at('2026-11-09T02:11:00Z');
    let expected = 0;
    for (let t = from.getTime(); t < to.getTime(); t += 60_000) {
      const localMinute = (Math.floor(t / 60_000) + 300) % 1440;
      if (localMinute >= 480) expected += 1;
    }
    expect(daytimeMinutesBetween(from, to)).toBe(expected);
  });

  it('an empty or reversed range counts nothing', () => {
    const t = at('2026-11-04T07:00:00Z');
    expect(daytimeMinutesBetween(t, t)).toBe(0);
    expect(daytimeMinutesBetween(at('2026-11-04T08:00:00Z'), t)).toBe(0);
  });

  it('isCardSilent: 6 daytime hours is silence, one minute less is not; a quiet night is not', () => {
    const last = at('2026-11-04T04:00:00Z'); // 09:00 local
    expect(isCardSilent(last, at('2026-11-04T10:00:00Z'))).toBe(true);
    expect(isCardSilent(last, at('2026-11-04T09:59:00Z'))).toBe(false);
    expect(isCardSilent(at('2026-11-04T17:00:00Z'), at('2026-11-05T01:00:00Z'))).toBe(false);
    expect(isCardSilent(last, at('2026-11-04T07:00:00Z'), 3)).toBe(true);
  });
});
