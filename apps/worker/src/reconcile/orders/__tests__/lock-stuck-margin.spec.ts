import { MAX_SEND_ATTEMPTS, ORDER_LOCK_STUCK_AFTER_MS } from '@repo/shared';
import { TON_CONFIRM_TIMEOUT_MAX_MS } from '../../../config/ton-env';

// S9d re-review R3: a run that legitimately holds `lock:order:{id}` the longest (every send
// attempt waiting the longest confirmation the env allows) must end before the lock watch calls
// its lease stuck; otherwise the owner hears `needsReview` about a healthy run. The reserve covers
// the rest of a run under the lease (re-quote, recipient re-check, prepare, DB writes). Raising
// MAX_SEND_ATTEMPTS or TON_CONFIRM_TIMEOUT_MAX_MS, or lowering ORDER_LOCK_STUCK_AFTER_MS, past
// this fails here first.

const RUN_RESERVE_MS = 5 * 60_000;

describe('the stuck-lease threshold against the longest healthy run', () => {
  it('MAX_SEND_ATTEMPTS x TON_CONFIRM_TIMEOUT_MAX_MS + reserve < ORDER_LOCK_STUCK_AFTER_MS', () => {
    const longestRunMs = MAX_SEND_ATTEMPTS * TON_CONFIRM_TIMEOUT_MAX_MS + RUN_RESERVE_MS;
    expect(longestRunMs).toBeLessThan(ORDER_LOCK_STUCK_AFTER_MS);
  });
});
