import { FX_MAX_AGE_MS } from '@repo/shared';
import { buildQuoteFixtures } from './quotes-e2e.fixtures';
import { useQuotesE2e } from './quotes-e2e.helpers';

describe('POST /quotes price freshness, limits and concurrency (e2e)', () => {
  const t = useQuotesE2e(buildQuoteFixtures);
  const quoteCount = (userId: string) => t.db.quote.count({ where: { userId } });
  const at = (offsetMs: number) => new Date(t.base.getTime() + offsetMs);

  async function quote(
    userId: string,
    user: Awaited<ReturnType<typeof t.newUser>>,
    productId: string,
    skuId: string | undefined,
  ) {
    const recipientToken = await t.token(userId, productId);
    return t.post({ productId, skuId, recipientToken }, user);
  }

  describe('freshness (inclusive 30:00 boundary)', () => {
    it('an FX rate exactly 30:00 old is usable', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      t.setNow(at(FX_MAX_AGE_MS));
      const res = await quote(user.id, user, f.fxProbe.id, f.fxProbe.sku[50]);
      expect(res.status).toBe(201);
      expect(await quoteCount(user.id)).toBe(1);
    });

    it('an FX rate 30:00.001 old -> 503 PRICE_UNAVAILABLE and no Quote row', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      t.setNow(at(FX_MAX_AGE_MS + 1));
      const res = await quote(user.id, user, f.fxProbe.id, f.fxProbe.sku[50]);
      expect([res.status, res.body.error?.code]).toEqual([503, 'PRICE_UNAVAILABLE']);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(await quoteCount(user.id)).toBe(0);
    });

    it('a cost snapshot exactly 30:00 old is usable, 30:00.001 old -> 503, no Quote row', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const edge = await quote(user.id, user, f.costEdge.id, f.costEdge.sku[50]);
      expect(edge.status).toBe(201);
      const stale = await quote(user.id, user, f.costStale.id, f.costStale.sku[50]);
      expect([stale.status, stale.body.error?.code]).toEqual([503, 'PRICE_UNAVAILABLE']);
      expect(await quoteCount(user.id)).toBe(1);
    });

    it('a pack with no cost snapshot at all -> 503 and no Quote row', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const res = await quote(user.id, user, f.noCost.id, f.noCost.sku[50]);
      expect([res.status, res.body.error?.code]).toEqual([503, 'PRICE_UNAVAILABLE']);
      expect(await quoteCount(user.id)).toBe(0);
    });
  });

  describe('rate limit', () => {
    it('the 31st quote of a minute -> 429 with Retry-After; the first 30 succeed', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      for (let n = 1; n <= 30; n += 1) {
        const res = await quote(user.id, user, f.stars.id, f.stars.sku[50]);
        expect([n, res.status]).toEqual([n, 201]);
      }
      const limited = await quote(user.id, user, f.stars.id, f.stars.sku[50]);
      expect([limited.status, limited.body.error?.code]).toEqual([429, 'RATE_LIMITED']);
      const retryAfter = Number(limited.headers['retry-after']);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(limited.headers['cache-control']).toBe('no-store');
      expect(await quoteCount(user.id)).toBe(30);

      // The budget is per user: another account is unaffected.
      const other = await t.newUser();
      const ok = await quote(other.id, other, f.stars.id, f.stars.sku[50]);
      expect(ok.status).toBe(201);
    });
  });

  describe('concurrency', () => {
    it('20 parallel quotes by one user -> 20 distinct rows, all owned by the caller', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const tokens = await Promise.all(
        Array.from({ length: 20 }, () => t.token(user.id, f.stars.id)),
      );
      const results = await Promise.all(
        tokens.map((recipientToken) =>
          t.post({ productId: f.stars.id, skuId: f.stars.sku[50], recipientToken }, user),
        ),
      );
      expect(results.map((res) => res.status)).toEqual(Array<number>(20).fill(201));
      const ids = results.map((res) => res.body.data?.['quoteId']);
      expect(new Set(ids).size).toBe(20);

      const rows = await t.db.quote.findMany({ where: { id: { in: ids.map(String) } } });
      expect(rows).toHaveLength(20);
      expect(new Set(rows.map((row) => row.userId))).toEqual(new Set([user.id]));
    });

    it('the same token used by 20 parallel requests is not consumed: all succeed', async () => {
      const f = t.fixtures();
      const user = await t.newUser();
      const recipientToken = await t.token(user.id, f.stars.id);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          t.post({ productId: f.stars.id, skuId: f.stars.sku[50], recipientToken }, user),
        ),
      );
      expect(results.every((res) => res.status === 201)).toBe(true);
      expect(await quoteCount(user.id)).toBe(20);
    });
  });
});
