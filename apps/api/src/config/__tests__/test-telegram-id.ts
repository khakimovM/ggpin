// Synthetic Telegram ids for e2e users on the shared ggpin_test database, unique without luck.
// (Under src/config because it reads JEST_WORKER_ID, the test runner's env.)
//
// The old `Date.now() * 4000 + random(4000)` collided: 50 users created in the same millisecond
// picked from 4000 values (about 26 % for one clash), and `ensureTelegramUser` then returned the
// SAME user twice, so a "fresh" user already had a PENDING request (409). Now:
//
//  - inside one process the id strictly increases (a counter that never falls behind the clock);
//  - jest workers running in parallel own different residues modulo SLOTS (JEST_WORKER_ID);
//  - files and runs that follow each other start from the clock (`Date.now() * 4000`, rounded to
//    a SLOTS multiple), which advances 4000 ids per millisecond, far faster than users are made.
// Values stay below 2^53 (Date.now() * 4000 is about 7.1e15), so they are safe JS integers too.

const SLOTS = 64;
const PER_MS = 4000;
const slot = Number(process.env['JEST_WORKER_ID'] ?? '1') % SLOTS;
let lastBase = 0;

/** The next unique Telegram id of this process. */
export function nextTestTelegramId(): number {
  const floor = Math.floor((Date.now() * PER_MS) / SLOTS) * SLOTS;
  lastBase = Math.max(lastBase + SLOTS, floor);
  return lastBase + slot;
}
