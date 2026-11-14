import { QuoteResponseSchema } from '@repo/shared';
import { RedisService } from '../../../infra/redis/redis.service';
import { recipientTokenKey } from '../../recipients/recipient-token.store';
import { buildQuoteFixtures } from './quotes-e2e.fixtures';
import { RECIPIENT, useQuotesE2e } from './quotes-e2e.helpers';

describe('POST /quotes (e2e)', () => {
  const t = useQuotesE2e(buildQuoteFixtures);
  const quoteRows = (userId: string) => t.db.quote.findMany({ where: { userId } });

  describe('happy path', () => {
    it('quotes a fixed pack: 201, contract shape, locked row owned by the caller', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const recipientToken = await t.token(user.id, f.stars.id);
      const res = await t.post(
        { productId: f.stars.id, skuId: f.stars.sku[50], recipientToken },
        user,
      );
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const data = QuoteResponseSchema.parse(res.body.data);
      // 50 stars = 5 000 so'm cost, +10% = 5 500 so'm = 550 000 tiyin.
      expect(data).toEqual({
        quoteId: data.quoteId,
        priceTiyin: '550000',
        discountTiyin: '0',
        totalTiyin: '550000',
        expiresAt: new Date(t.base.getTime() + 600_000).toISOString(),
        recipient: RECIPIENT,
        currency: 'UZS',
      });
      expect(Object.keys(res.body.data ?? {}).sort()).toEqual([
        'currency',
        'discountTiyin',
        'expiresAt',
        'priceTiyin',
        'quoteId',
        'recipient',
        'totalTiyin',
      ]);

      const rows = await quoteRows(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: data.quoteId,
        userId: user.id,
        productId: f.stars.id,
        skuId: f.stars.sku[50],
        quantity: 50,
        recipient: RECIPIENT,
        // The validate call's provider-side id travels from the token record to the quote
        // (docs/06 S2), and from there to the order; it is never in the response (checked below).
        providerRef: 'fragment-ref-1',
        costCurrency: 'TON',
        costMinor: 125_000_000n,
        fxRateId: f.fxId,
        costSnapshotId: f.stars.costId,
        priceTiyin: 550_000n,
        // 3% tolerance (128 750 000) is lower than the margin cap (137 500 000).
        maxCostMinor: 128_750_000n,
        discountCodeId: null,
        usedAt: null,
        expiresAt: new Date(t.base.getTime() + 600_000),
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /cost|maxCost|fxRate|snapshot|markup|providerRef|fragment-ref/i,
      );
    });

    it('quotes a custom quantity from the product-level cost with sku null', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const recipientToken = await t.token(user.id, f.stars.id);
      const res = await t.post({ productId: f.stars.id, quantity: 75, recipientToken }, user);
      expect(res.status).toBe(201);
      // 75 stars = 187 500 000 nano = 0.1875 TON = 7 500 so'm; the 50 pack's +10% = 8 250 so'm.
      expect(res.body.data).toMatchObject({ priceTiyin: '825000', totalTiyin: '825000' });
      const [row] = await quoteRows(user.id);
      expect(row).toMatchObject({
        skuId: null,
        quantity: 75,
        costMinor: 187_500_000n,
        costSnapshotId: f.stars.costId,
        // tolerance 187 500 000 x 1.03 = 193 125 000 < margin cap 206 250 000.
        maxCostMinor: 193_125_000n,
      });
    });

    it('a pack-level cost (Premium) prices its own pack', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const recipientToken = await t.token(user.id, f.premium.id);
      const res = await t.post(
        { productId: f.premium.id, skuId: f.premium.sku[3], recipientToken },
        user,
      );
      expect(res.status).toBe(201);
      // 3 TON = 120 000 so'm, +10% = 132 000 so'm.
      expect(res.body.data).toMatchObject({ priceTiyin: '13200000' });
      const [row] = await quoteRows(user.id);
      expect(row?.costSnapshotId).toBe(f.premium.costId);
      expect(row?.maxCostMinor).toBe(3_090_000_000n); // 3 000 000 000 x 1.03
    });

    it('maxCostMinor: the minimum-margin cap binds when it is below the tolerance cap', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const recipientToken = await t.token(user.id, f.margin.id);
      const res = await t.post(
        { productId: f.margin.id, skuId: f.margin.sku[50], recipientToken },
        user,
      );
      expect(res.status).toBe(201);
      // cost 500 000 tiyin, markup 0, floor = cost + 10 000 -> price 510 000 tiyin (5 100 so'm).
      expect(res.body.data).toMatchObject({ priceTiyin: '510000' });
      const [row] = await quoteRows(user.id);
      // margin cap: (510 000 - 10 000) tiyin = 5 000 so'm = 0.125 TON = 125 000 000 nano;
      // tolerance cap would be 128 750 000.
      expect(row?.maxCostMinor).toBe(125_000_000n);
    });

    it('the same token quotes another pack of the same product (not consumed)', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const recipientToken = await t.token(user.id, f.stars.id);
      for (const pack of [50, 100]) {
        const res = await t.post(
          { productId: f.stars.id, skuId: f.stars.sku[pack], recipientToken },
          user,
        );
        expect(res.status).toBe(201);
      }
      expect(await quoteRows(user.id)).toHaveLength(2);
    });
  });

  describe('recipient token', () => {
    it('another user, another product, unknown and expired tokens are one identical 422', async () => {
      const f = t.fixtures();
      const owner = await t.newUser();
      const other = await t.newUser();
      const body = (recipientToken: string) => ({
        productId: f.stars.id,
        skuId: f.stars.sku[50],
        recipientToken,
      });
      const mine = await t.token(owner.id, f.stars.id);
      const forPremium = await t.token(owner.id, f.premium.id);
      const expiring = await t.token(owner.id, f.stars.id);
      // Let Redis expire the key for real: 50 ms left, then wait it out.
      await t.app().get(RedisService).client.pexpire(recipientTokenKey(expiring), 50);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const results = [
        await t.post(body(mine), other), // user B uses user A's token
        await t.post(body(forPremium), owner), // token issued for another product
        await t.post(body('A'.repeat(43)), owner), // well-formed but never issued
        await t.post(body(expiring), owner), // expired
      ];
      for (const res of results) {
        expect(res.status).toBe(422);
        expect(res.body).toEqual({
          success: false,
          error: { code: 'RECIPIENT_INVALID', message: 'errors.RECIPIENT_INVALID' },
        });
        expect(res.headers['cache-control']).toBe('no-store');
      }
      expect(await quoteRows(owner.id)).toHaveLength(0);
      expect(await quoteRows(other.id)).toHaveLength(0);
    });

    it('the token lives 600 s in Redis under a hash key, not under the token', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const token = await t.token(user.id, f.stars.id);
      const redis = t.app().get(RedisService).client;
      expect(await redis.exists(`rcpt:${token}`)).toBe(0);
      const ttl = await redis.pttl(recipientTokenKey(token));
      expect(ttl).toBeGreaterThan(590_000);
      expect(ttl).toBeLessThanOrEqual(600_000);
    });
  });

  describe('authentication and CSRF', () => {
    it('no session -> 401, nothing written', async () => {
      const f = t.fixtures();
      const res = await t.post(
        { productId: f.stars.id, skuId: f.stars.sku[50], recipientToken: 'A'.repeat(43) },
        null,
        'none',
      );
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('cookie session without the CSRF header -> 404 NOT_FOUND (D-26), no quote', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const recipientToken = await t.token(user.id, f.stars.id);
      const body = { productId: f.stars.id, skuId: f.stars.sku[50], recipientToken };
      const res = await t.post(body, user, 'cookie');
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('NOT_FOUND');
      expect(await quoteRows(user.id)).toHaveLength(0);

      const ok = await t.post(body, user, 'cookie+csrf');
      expect(ok.status).toBe(201);
      expect(await quoteRows(user.id)).toHaveLength(1);
    });

    it('a Mini App bearer session needs no CSRF header', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const recipientToken = await t.token(user.id, f.stars.id);
      const res = await t.post(
        { productId: f.stars.id, skuId: f.stars.sku[50], recipientToken },
        user,
        'bearer',
      );
      expect(res.status).toBe(201);
    });
  });
});
