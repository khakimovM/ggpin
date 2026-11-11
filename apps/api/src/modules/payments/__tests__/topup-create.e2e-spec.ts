import { PayLinkUrlSchema, TopupIntentCreatedSchema } from '@repo/shared';
import { PAYMENT_METHODS_CACHE_KEY } from '../payment-methods.service';
import {
  BASE_TIYIN,
  HOUR,
  createBody,
  newKey,
  tokenOf,
  usePaymentsE2e,
  type Reply,
} from './payments-e2e.helpers';

const e2e = usePaymentsE2e();
const GRACE_MS = 86_400_000;

function created(res: Reply) {
  expect(res.status).toBe(201);
  return TopupIntentCreatedSchema.parse(res.body.data);
}

describe('POST /payments/intents: the 201', () => {
  it('base + 1..999 so‘m on our card, the pay link with the user locale, reservedUntil = expiresAt + grace in the row', async () => {
    const card = await e2e.card({ bank: 'HUMO' });
    const user = await e2e.newUser({ locale: 'ru' });
    const before = Date.now();
    const data = created(await e2e.create(user));

    const extra = BigInt(data.payAmountTiyin) - BASE_TIYIN;
    expect(extra >= 100n && extra <= 99_900n && extra % 100n === 0n).toBe(true);
    expect(data).toMatchObject({
      status: 'PENDING',
      baseAmountTiyin: '2000000',
      currency: 'UZS',
      card: { bank: 'HUMO', number: card.pan, holderName: 'TESTOV S.' },
    });
    expect(PayLinkUrlSchema.parse(data.redirectUrl)).toMatch(
      new RegExp(`^${e2e.env.WEB_URL}/pay/${data.intentId}\\?locale=ru#t=[A-Za-z0-9_-]{43}$`),
    );
    const expiresAt = Date.parse(data.expiresAt);
    expect(expiresAt - before).toBeGreaterThanOrEqual(1_800_000 - 1_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(1_800_000);

    const row = await e2e.db().paymentIntent.findUniqueOrThrow({ where: { id: data.intentId } });
    expect(row.cardId).toBe(card.id);
    expect(row.reservedUntil?.getTime()).toBe(row.expiresAt.getTime() + GRACE_MS);
    // Only the HMAC of the token is stored.
    expect(row.payTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.payTokenHash).not.toContain(tokenOf(data.redirectUrl));
  });

  it('a missing or malformed Idempotency-Key is 400 VALIDATION_ERROR, nothing created', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const missing = await e2e.send('POST', '/payments/intents', user.bearer, createBody());
    expect(missing.status).toBe(400);
    expect(missing.body.error?.code).toBe('VALIDATION_ERROR');
    const bad = await e2e.create(user, createBody(), 'short');
    expect(bad.status).toBe(400);
    expect(await e2e.db().paymentIntent.count({ where: { userId: user.id } })).toBe(0);
  });

  it('TOPUP_AND_BUY, quoteId or another provider is 400 (strict body)', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    for (const body of [
      { ...createBody(), purpose: 'TOPUP_AND_BUY' },
      { ...createBody(), quoteId: 'q1' },
      { ...createBody(), provider: 'CLICK' },
    ]) {
      expect((await e2e.create(user, body)).status).toBe(400);
    }
  });
});

describe('POST /payments/intents: idempotency', () => {
  it('replay with the same body: the same intent and amount, a NEW token; the old token is dead (404)', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const key = newKey();
    const first = created(await e2e.create(user, createBody(), key));
    const again = created(await e2e.create(user, createBody(), key));

    expect(again.intentId).toBe(first.intentId);
    expect(again.payAmountTiyin).toBe(first.payAmountTiyin);
    expect(tokenOf(again.redirectUrl)).not.toBe(tokenOf(first.redirectUrl));
    expect((await e2e.pay(first.intentId, tokenOf(first.redirectUrl))).status).toBe(404);
    expect((await e2e.pay(first.intentId, tokenOf(again.redirectUrl))).status).toBe(200);
    expect(await e2e.db().paymentIntent.count({ where: { userId: user.id } })).toBe(1);
  });

  it('the same key with another body is 409 IDEMPOTENCY_CONFLICT with the intent id', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const key = newKey();
    const first = created(await e2e.create(user, createBody(), key));
    const res = await e2e.create(user, createBody(3_000_000n), key);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { intentId: first.intentId },
    });
  });

  it('the same key after the intent was cancelled is 409 IDEMPOTENCY_CONFLICT (no new link)', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const key = newKey();
    const first = created(await e2e.create(user, createBody(), key));
    await e2e.post(`/payments/intents/${first.intentId}/cancel`, user);
    const res = await e2e.create(user, createBody(), key);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ details: { intentId: first.intentId } });
  });
});

describe('POST /payments/intents: one PENDING per user', () => {
  it('a second request with a new key is 409 TOPUP_ALREADY_PENDING with the pending intent id', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const first = created(await e2e.create(user));
    const res = await e2e.create(user, createBody(1_000_000n));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'TOPUP_ALREADY_PENDING',
      details: { intentId: first.intentId },
    });
  });

  it('two parallel requests of one user with different keys: one 201, one 409 (DB unique)', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const results = await Promise.all([e2e.create(user), e2e.create(user)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await e2e.db().paymentIntent.count({ where: { userId: user.id } })).toBe(1);
  });
});

describe('POST /payments/intents: amount range and the daily caps (base amounts)', () => {
  it.each([
    ['below the minimum', 400_000n],
    ['above the maximum', 200_100_000n],
    ['not a multiple of 1 000 so‘m', 2_050_000n],
  ])('%s is 422 TOPUP_AMOUNT_OUT_OF_RANGE with min/max/step', async (_name, amount) => {
    await e2e.card();
    const user = await e2e.newUser({ ageDays: 30 });
    const res = await e2e.create(user, createBody(amount));
    expect(res.status).toBe(422);
    expect(res.body.error).toEqual(
      expect.objectContaining({
        code: 'TOPUP_AMOUNT_OUT_OF_RANGE',
        details: { min: '500000', max: '200000000', step: '100000' },
      }),
    );
  });

  it('new account: exactly 500 000 so‘m is fine, 501 000 so‘m is 422 with what is left (max)', async () => {
    await e2e.card();
    created(await e2e.create(await e2e.newUser(), createBody(50_000_000n)));
    const res = await e2e.create(await e2e.newUser(), createBody(50_100_000n));
    expect(res.status).toBe(422);
    expect(res.body.error?.details).toEqual({
      min: '500000',
      max: '50000000',
      step: '100000',
      reason: 'NEW_ACCOUNT_DAILY_LIMIT',
    });
  });

  it('new account with 499 000 so‘m paid today: max (1 000 so‘m) is below min, still 422', async () => {
    await e2e.card();
    const holder = await e2e.card({ status: 'VERIFYING' });
    const user = await e2e.newUser();
    const createdAt = new Date(Date.now() - 2 * HOUR);
    await e2e.fixtureIntent(user.id, {
      cardId: holder.id,
      baseTiyin: 49_900_000n,
      suffixSom: 7,
      status: 'PAID',
      createdAt,
      paidAt: new Date(createdAt.getTime() + 60_000),
      reservedUntil: new Date(Date.now() + 22 * HOUR),
    });
    const res = await e2e.create(user, createBody(500_000n));
    expect(res.status).toBe(422);
    expect(res.body.error?.details).toMatchObject({ min: '500000', max: '100000' });
  });

  it('old account: no new-account cap, but 5 000 000 so‘m per 24 h counting PAID and PENDING; CANCELLED frees its share', async () => {
    await e2e.card();
    const holder = await e2e.card({ status: 'VERIFYING' });
    const user = await e2e.newUser({ ageDays: 30 });
    const createdAt = new Date(Date.now() - 3 * HOUR);
    for (const suffixSom of [1, 2]) {
      await e2e.fixtureIntent(user.id, {
        cardId: holder.id,
        baseTiyin: 200_000_000n,
        suffixSom,
        status: 'PAID',
        createdAt,
        paidAt: new Date(createdAt.getTime() + 60_000),
        reservedUntil: new Date(Date.now() + 22 * HOUR),
      });
    }
    // 4 000 000 used: 1 000 000 is exactly the rest.
    const last = created(await e2e.create(user, createBody(100_000_000n)));
    await e2e.post(`/payments/intents/${last.intentId}/cancel`, user);
    const over = await e2e.create(user, createBody(100_100_000n));
    expect(over.status).toBe(422);
    expect(over.body.error?.details).toMatchObject({ max: '100000000', reason: 'DAILY_LIMIT' });
    // The cancelled request did not count: the full rest is still available.
    created(await e2e.create(user, createBody(100_000_000n)));
  });
});

describe('GET /payments/methods', () => {
  it('per bank: available only with a card that has room and a live listener', async () => {
    await e2e.card({ bank: 'HUMO' });
    const user = await e2e.newUser();
    const res = await e2e.get('/payments/methods', user);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        code: 'P2P_CARD',
        available: true,
        banks: [
          { bank: 'HUMO', available: true },
          { bank: 'UZCARD', available: false },
        ],
        minTiyin: '500000',
        maxTiyin: '200000000',
        stepTiyin: '100000',
      },
    ]);
    await e2e.heartbeat(10 * 60_000);
    await e2e.redis().del(PAYMENT_METHODS_CACHE_KEY);
    const stale = await e2e.get('/payments/methods', user);
    expect(stale.body.data).toEqual([expect.objectContaining({ available: false })]);
  });

  it('the answer is cached in Redis for 5 s: a change inside the window is not seen until the key goes (S4-06)', async () => {
    await e2e.card({ bank: 'HUMO' });
    const user = await e2e.newUser();
    const first = await e2e.get('/payments/methods', user);
    expect(first.body.data).toEqual([expect.objectContaining({ available: true })]);
    const ttl = await e2e.redis().ttl(PAYMENT_METHODS_CACHE_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
    // The listener goes stale: the cached answer is still served inside the window...
    await e2e.heartbeat(10 * 60_000);
    expect((await e2e.get('/payments/methods', user)).body).toEqual(first.body);
    // ...and recomputed once the key is gone.
    await e2e.redis().del(PAYMENT_METHODS_CACHE_KEY);
    const fresh = await e2e.get('/payments/methods', user);
    expect(fresh.body.data).toEqual([expect.objectContaining({ available: false })]);
  });

  it('an unreadable cache entry is a miss, never an error', async () => {
    await e2e.card({ bank: 'HUMO' });
    const user = await e2e.newUser();
    await e2e.redis().set(PAYMENT_METHODS_CACHE_KEY, '{"not":"methods"}', 'EX', 5);
    const res = await e2e.get('/payments/methods', user);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ available: true })]);
  });
});
