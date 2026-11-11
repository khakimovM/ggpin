import { BANK_FEED_HEARTBEAT_KEY, TopupIntentCreatedSchema } from '@repo/shared';
import {
  BASE_TIYIN,
  HOUR,
  MINUTE,
  createBody,
  usePaymentsE2e,
  type Reply,
} from './payments-e2e.helpers';

const e2e = usePaymentsE2e();

function retryAfter(res: Reply): number {
  return Number(res.headers['retry-after']);
}

describe('POST /payments/intents: request rate (before validation)', () => {
  it('the 6th attempt in 10 minutes is 429 RATE_LIMITED with Retry-After, refused attempts count too', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    for (let i = 0; i < 5; i += 1) {
      expect((await e2e.create(user, createBody(400_000n))).status).toBe(422);
    }
    const sixth = await e2e.create(user);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error?.code).toBe('RATE_LIMITED');
    expect(retryAfter(sixth)).toBeGreaterThan(0);
    expect(retryAfter(sixth)).toBeLessThanOrEqual(600);
    expect(await e2e.db().paymentIntent.count({ where: { userId: user.id } })).toBe(0);
  });

  it('10 intents CREATED in 24 h: the next is 429 with Retry-After until the oldest leaves the window', async () => {
    await e2e.card();
    const holder = await e2e.card({ status: 'VERIFYING' });
    const user = await e2e.newUser({ ageDays: 30 });
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) {
      const createdAt = new Date(now - 23 * HOUR + i * MINUTE);
      await e2e.fixtureIntent(user.id, {
        cardId: holder.id,
        baseTiyin: BASE_TIYIN,
        suffixSom: i + 1,
        status: 'EXPIRED',
        createdAt,
        reservedUntil: new Date(createdAt.getTime() + 30 * MINUTE),
      });
    }
    const res = await e2e.create(user);
    expect(res.status).toBe(429);
    // The oldest was created 23 h ago: it leaves the 24 h window in about one hour.
    expect(retryAfter(res)).toBeGreaterThan(3_500);
    expect(retryAfter(res)).toBeLessThanOrEqual(3_600);
  });
});

describe('POST /payments/intents: at most 3 UNPAID reserved requests', () => {
  it('3 cancelled/expired requests still in their reservation: 429, Retry-After = the nearest reservedUntil', async () => {
    await e2e.card();
    const holder = await e2e.card({ status: 'VERIFYING' });
    const user = await e2e.newUser({ ageDays: 30 });
    const createdAt = new Date(Date.now() - HOUR);
    const ends = [5 * HOUR, 2 * HOUR, 9 * HOUR];
    for (const [i, end] of ends.entries()) {
      await e2e.fixtureIntent(user.id, {
        cardId: holder.id,
        baseTiyin: BASE_TIYIN,
        suffixSom: i + 1,
        status: i === 0 ? 'EXPIRED' : 'CANCELLED',
        createdAt,
        reservedUntil: new Date(Date.now() + end),
      });
    }
    const res = await e2e.create(user);
    expect(res.status).toBe(429);
    expect(res.body.error?.code).toBe('RATE_LIMITED');
    expect(retryAfter(res)).toBeGreaterThan(2 * 3600 - 60);
    expect(retryAfter(res)).toBeLessThanOrEqual(2 * 3600);
  });

  it('PAID requests and reservations that already ended do not count', async () => {
    await e2e.card();
    const holder = await e2e.card({ status: 'VERIFYING' });
    const user = await e2e.newUser({ ageDays: 30 });
    const createdAt = new Date(Date.now() - 3 * HOUR);
    for (let i = 0; i < 3; i += 1) {
      await e2e.fixtureIntent(user.id, {
        cardId: holder.id,
        baseTiyin: 500_000n,
        suffixSom: i + 1,
        status: 'PAID',
        createdAt,
        paidAt: new Date(createdAt.getTime() + MINUTE),
        reservedUntil: new Date(Date.now() + 20 * HOUR),
      });
    }
    await e2e.fixtureIntent(user.id, {
      cardId: holder.id,
      baseTiyin: 500_000n,
      suffixSom: 9,
      status: 'CANCELLED',
      createdAt,
      reservedUntil: new Date(createdAt.getTime() + HOUR),
    });
    await e2e.fixtureIntent(user.id, {
      cardId: holder.id,
      baseTiyin: 500_000n,
      suffixSom: 10,
      status: 'CANCELLED',
      createdAt,
      reservedUntil: new Date(Date.now() + HOUR),
    });
    expect((await e2e.create(user)).status).toBe(201);
  });
});

describe('POST /payments/intents: listener and card capacity (503)', () => {
  it.each([
    ['stale', async () => e2e.heartbeat(121_000)],
    ['missing', async () => void (await e2e.redis().del(BANK_FEED_HEARTBEAT_KEY))],
    ['unreadable', async () => void (await e2e.redis().set(BANK_FEED_HEARTBEAT_KEY, 'soon'))],
  ])('a %s bank-feed heartbeat: 503 PAYMENT_METHOD_UNAVAILABLE, nothing written', async (_n, f) => {
    await e2e.card();
    const user = await e2e.newUser();
    await f();
    const res = await e2e.create(user);
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    expect(await e2e.db().paymentIntent.count({ where: { userId: user.id } })).toBe(0);
  });

  it('a card whose free capacity is below base + the largest suffix is not used: 503', async () => {
    await e2e.card({ limitTiyin: BASE_TIYIN + 99_900n - 1n });
    const res = await e2e.create(await e2e.newUser());
    expect(res.status).toBe(503);
  });

  it('a monthly cap below the request makes the card unusable even with a large life limit', async () => {
    await e2e.card({ monthlyLimitTiyin: BASE_TIYIN });
    expect((await e2e.create(await e2e.newUser())).status).toBe(503);
  });

  it('VERIFYING, FULL, DRAINING, RETIRED and paused cards never get a request', async () => {
    for (const status of ['VERIFYING', 'FULL', 'DRAINING', 'RETIRED'] as const) {
      await e2e.card({ status });
    }
    await e2e.card({ autoCreditPaused: true });
    const user = await e2e.newUser();
    expect((await e2e.create(user)).status).toBe(503);

    const active = await e2e.card();
    const res = await e2e.create(user);
    expect(TopupIntentCreatedSchema.parse(res.body.data).card?.number).toBe(active.pan);
  });

  it('the bank filter: UZCARD asked, UZCARD given; HUMO asked with only UZCARD cards: 503', async () => {
    const uzcard = await e2e.card({ bank: 'UZCARD' });
    const res = await e2e.create(await e2e.newUser(), createBody(BASE_TIYIN, { bank: 'UZCARD' }));
    expect(TopupIntentCreatedSchema.parse(res.body.data).card).toMatchObject({
      bank: 'UZCARD',
      number: uzcard.pan,
    });
    const humo = await e2e.create(await e2e.newUser(), createBody(BASE_TIYIN, { bank: 'HUMO' }));
    expect(humo.status).toBe(503);
  });

  it('sticky card: the card of the user’s previous request comes first while it has room', async () => {
    await e2e.card({ limitTiyin: 900_000_000_000_000n });
    const previous = await e2e.card({ limitTiyin: 10_000_000_000n });
    const user = await e2e.newUser({ ageDays: 30 });
    const createdAt = new Date(Date.now() - 3 * HOUR);
    await e2e.fixtureIntent(user.id, {
      cardId: previous.id,
      baseTiyin: BASE_TIYIN,
      suffixSom: 5,
      status: 'EXPIRED',
      createdAt,
      reservedUntil: new Date(createdAt.getTime() + HOUR),
    });
    const sticky = TopupIntentCreatedSchema.parse((await e2e.create(user)).body.data);
    expect(sticky.card?.number).toBe(previous.pan);
    // Another user without history gets the card with the most free capacity.
    const fresh = TopupIntentCreatedSchema.parse((await e2e.create(await e2e.newUser())).body.data);
    expect(fresh.card?.number).not.toBe(previous.pan);
  });
});
