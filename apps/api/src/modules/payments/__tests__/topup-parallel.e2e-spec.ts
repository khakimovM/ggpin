import { TopupIntentCreatedSchema } from '@repo/shared';
import { AMOUNT_RANDOM } from '../amount-allocator';
import {
  CARD_LOCK_TIMING,
  DEFAULT_CARD_LOCK_TIMING,
  type CardLockTiming,
} from '../card-lock-timing';
import { newKey, tokenOf, usePaymentsE2e, type Reply } from './payments-e2e.helpers';

// The suffix random source is pinned to 0: every request, if it decided alone, would take the
// SAME (smallest free) amount. 50 different amounts therefore prove that uniqueness comes from
// the per-card advisory lock and the amount usage re-read under it (backed by the DB EXCLUDE),
// not from the random pick being lucky.
//
// All 50 queue on ONE card lock, so on a slow CI machine the last one may wait longer than the
// production lock_timeout (3 s) and would get a 503 that proves nothing. The suite gives the
// lock wait and the transaction more room (m-C); maxWait stays below pg's 5 s pool timeout,
// which remains the real bound, and the test reports how long the burst took.
const PATIENT: CardLockTiming = {
  lockWaitMs: 30_000,
  maxWaitMs: DEFAULT_CARD_LOCK_TIMING.maxWaitMs,
  timeoutMs: 60_000,
};
const e2e = usePaymentsE2e({
  overrides: [
    { provide: AMOUNT_RANDOM, useValue: () => 0 },
    { provide: CARD_LOCK_TIMING, useValue: PATIENT },
  ],
});

function created(res: Reply) {
  expect(res.status).toBe(201);
  return TopupIntentCreatedSchema.parse(res.body.data);
}

describe('POST /payments/intents under concurrency', () => {
  it('50 users at once on ONE card, random fixed at 0: 50 x 201 with 50 different pay amounts', async () => {
    const card = await e2e.card();
    const users = await Promise.all(Array.from({ length: 50 }, () => e2e.newUser()));
    const started = Date.now();
    const results = await Promise.all(users.map((user) => e2e.create(user)));
    const elapsedMs = Date.now() - started;
    // On a failure the statuses and the burst time say whether it was the lock or the pool.
    const failed = results.map((r) => r.status).filter((s) => s !== 201);
    expect({ failed, elapsedMs }).toEqual({ failed: [], elapsedMs });
    const bodies = results.map(created);
    expect(new Set(bodies.map((b) => b.payAmountTiyin)).size).toBe(50);
    expect(new Set(bodies.map((b) => b.card?.number))).toEqual(new Set([card.pan]));
  }, 60_000);

  it('two parallel requests with the same key and body: both 201, one intent, one row, only the last token opens the page (m3)', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const key = newKey();
    const [a, b] = (
      await Promise.all([e2e.create(user, undefined, key), e2e.create(user, undefined, key)])
    ).map(created);
    if (a === undefined || b === undefined) throw new Error('expected two answers');
    expect(a.intentId).toBe(b.intentId);
    expect(a.payAmountTiyin).toBe(b.payAmountTiyin);
    expect(
      await e2e.db().paymentIntent.count({ where: { userId: user.id, idempotencyKey: key } }),
    ).toBe(1);

    // The replay rotated the token, so exactly one of the two links still works.
    const tokens = [tokenOf(a.redirectUrl), tokenOf(b.redirectUrl)];
    expect(tokens[0]).not.toBe(tokens[1]);
    const statuses: number[] = [];
    for (const token of tokens) statuses.push((await e2e.pay(a.intentId, token)).status);
    expect([...statuses].sort((x, y) => x - y)).toEqual([200, 404]);
  });
});
