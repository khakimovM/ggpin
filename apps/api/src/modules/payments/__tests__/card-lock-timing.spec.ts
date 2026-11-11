import { CONNECTION_TIMEOUT_MS } from '@repo/db';
import { DEFAULT_CARD_LOCK_TIMING } from '../card-lock-timing';

describe('DEFAULT_CARD_LOCK_TIMING', () => {
  it('maxWait is below the pg pool timeout, so an exhausted pool is P2028 (503), not a raw pg error', () => {
    expect(DEFAULT_CARD_LOCK_TIMING.maxWaitMs).toBeLessThan(CONNECTION_TIMEOUT_MS);
  });

  it('a card lock wait fits inside the transaction timeout', () => {
    expect(DEFAULT_CARD_LOCK_TIMING.lockWaitMs).toBeLessThan(DEFAULT_CARD_LOCK_TIMING.timeoutMs);
  });
});
