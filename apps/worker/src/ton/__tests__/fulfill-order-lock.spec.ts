import { FULFILL_ORDER_LOCK_DURATION_MS } from '@repo/shared';
import { DEFAULT_LOCK_TTL_MS } from '../ton-tokens';

// The real invariant of the fulfill-order lock (review RR2 #3, fulfill-order-config.ts): a dead
// worker's job is delivered again only after its TON wallet lease has lapsed, so the new delivery
// is not turned away as WALLET_BUSY by the dead one. BullMQ renews the lock every lockDuration / 2,
// so a worker that dies right after a renewal leaves a lock that lapses lockDuration / 2 later:
// that shortest wait must cover a full wallet lease. The confirmation wait is NOT bounded by the
// lock: a live worker renews it, and a stalled delivery only follows the attempt's transfer
// (findByAttempt), never signs again (ton-sender.e2e-spec.ts).

describe('the fulfill-order lock duration (BullMQ lockDuration)', () => {
  it('outlasts the TON wallet lease even in its shortest case, so a redelivered job finds the wallet free', () => {
    expect(FULFILL_ORDER_LOCK_DURATION_MS / 2).toBeGreaterThanOrEqual(DEFAULT_LOCK_TTL_MS);
  });
});
