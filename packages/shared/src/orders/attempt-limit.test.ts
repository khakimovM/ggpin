import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_LIMIT_HOLD_WHY,
  MAX_SEND_ATTEMPTS,
  attemptLimitReached,
  coreHoldNote,
  isAttemptHoldError,
  sendAttemptsUsed,
  type NumberedAttemptRow,
} from './attempt-limit';

describe('attempt limit (the worker rule, S10 fix round item 1)', () => {
  it('a hold-failed attempt does not count; a payout proven not sent does', () => {
    for (const hold of [
      'LIMIT_PER_ORDER',
      'LIMIT_DAILY',
      'LOW_BALANCE',
      'PAY_ADDRESS_NOT_ALLOWED',
    ]) {
      expect(isAttemptHoldError(hold)).toBe(true);
    }
    expect(isAttemptHoldError('TON_NOT_SENT_WALLET_BUSY')).toBe(true);
    for (const counted of ['TON_EXPIRED', 'NOT_SENT', 'review resolved: MANUAL', null]) {
      expect(isAttemptHoldError(counted)).toBe(false);
    }
  });

  it('the cap is reached at MAX_SEND_ATTEMPTS counted attempts', () => {
    expect(MAX_SEND_ATTEMPTS).toBe(2);
    const proven = { error: 'TON_EXPIRED' };
    const held = { error: 'LOW_BALANCE' };
    expect(sendAttemptsUsed([proven, held, held])).toBe(1);
    expect(attemptLimitReached([proven, held])).toBe(false);
    expect(attemptLimitReached([proven, { error: null }])).toBe(true);
    expect(attemptLimitReached([])).toBe(false);
  });

  it('formats the core hold note as the worker writes it', () => {
    expect(coreHoldNote('ADAPTER_ERROR', ATTEMPT_LIMIT_HOLD_WHY)).toBe(
      'core hold: ADAPTER_ERROR (every attempt was proven not sent)',
    );
  });

  describe('OWNER release (D-64 (5), D-66): only attempts numbered above it count', () => {
    const proven = (attemptNo: number) => ({ error: 'TON_EXPIRED', attemptNo });

    it('attempts up to the release number do not count; the boundary is strict', () => {
      expect(sendAttemptsUsed([proven(1), proven(2)], 2)).toBe(0);
      expect(attemptLimitReached([proven(1), proven(2)], 2)).toBe(false);
      // attemptNo === released: not counted; released + 1: counted.
      expect(sendAttemptsUsed([proven(2)], 2)).toBe(0);
      expect(sendAttemptsUsed([proven(3)], 2)).toBe(1);
      expect(attemptLimitReached([proven(1), proven(2), proven(3)], 2)).toBe(false);
      expect(attemptLimitReached([proven(1), proven(2), proven(3), proven(4)], 2)).toBe(true);
    });

    it('hold-failed attempts after the release still do not count', () => {
      const held = { error: 'LOW_BALANCE', attemptNo: 4 };
      expect(sendAttemptsUsed([proven(1), proven(2), proven(3), held], 2)).toBe(1);
    });

    it.each([Number.NaN, -1, 0, 1.5, Number.POSITIVE_INFINITY, 2 ** 53])(
      'fail-closed: a release number %p that is not a positive integer hides nothing',
      (released) => {
        expect(sendAttemptsUsed([proven(1), proven(2)], released)).toBe(2);
        expect(attemptLimitReached([proven(1), proven(2)], released)).toBe(true);
      },
    );

    it.each([Number.NaN, 1.5, -3, Number.NEGATIVE_INFINITY])(
      'fail-closed: an attempt numbered %p still counts',
      (attemptNo) => {
        expect(sendAttemptsUsed([{ error: null, attemptNo }], 5)).toBe(1);
      },
    );

    it('an attempt without attemptNo (a JS caller) still counts', () => {
      const unnumbered = [
        { error: 'TON_EXPIRED' },
        { error: null },
      ] as unknown as NumberedAttemptRow[];
      expect(sendAttemptsUsed(unnumbered, 1)).toBe(2);
      expect(attemptLimitReached(unnumbered, 1)).toBe(true);
    });

    it('no release (null or omitted): every attempt counts, the old result', () => {
      const all = [proven(1), proven(2), proven(3)];
      expect(sendAttemptsUsed(all, null)).toBe(3);
      expect(sendAttemptsUsed(all, undefined)).toBe(3);
      expect(sendAttemptsUsed(all)).toBe(3);
      expect(attemptLimitReached([proven(1), proven(2)], null)).toBe(true);
      expect(attemptLimitReached([proven(1), proven(2)])).toBe(true);
    });
  });
});
