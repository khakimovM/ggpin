import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_LIMIT_HOLD_WHY,
  MAX_SEND_ATTEMPTS,
  attemptLimitReached,
  coreHoldNote,
  isAttemptHoldError,
  sendAttemptsUsed,
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
});
