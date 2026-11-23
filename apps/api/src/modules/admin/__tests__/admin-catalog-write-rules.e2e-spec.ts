import { randomUUID } from 'node:crypto';
import { PREMIUM_PRODUCT_SLUG } from '@repo/shared';
import { AdminCatalogWriteRepository } from '../catalog/admin-catalog-write.repository';
import { catalogKit, packageBody } from './admin-catalog-write.e2e-kit';
import type { Res } from './admin-e2e.api';
import { useAdminE2e } from './admin-e2e.harness';
import { heldTransaction, waitForLockWaiter } from './admin-e2e.locks';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S8a: the catalog rules on the real database (docs/04 «Katalog», owner Q5/Q6 and
// 2026-11-22): DUPLICATE_PACKAGE under the Product row lock, QUANTITY_RANGE, PREMIUM_MONTHS,
// the reorder's full set, and the lock mode (FOR NO KEY UPDATE: foreign-key inserts go on).
const t = useAdminE2e();
const kit = adminWriteKit(t);
const cat = catalogKit(t);

const fields = (res: Res): unknown => errorOf(res).details;
/** The reorder body is at most 500 ids (AdminProductReorderBodySchema). */
const REORDER_MAX = 500;

/** Resolves 'done' when `work` finishes within `ms`, 'blocked' otherwise. */
const within = async (work: Promise<unknown>, ms: number): Promise<'done' | 'blocked'> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'blocked'>((resolve) => {
    timer = setTimeout(() => resolve('blocked'), ms);
  });
  try {
    return await Promise.race([work.then(() => 'done' as const), late]);
  } finally {
    clearTimeout(timer);
  }
};
describe('admin catalog rules (S8a)', () => {
  let owner: Session;
  // A session per test: the admin write limit is 30 a minute per session (docs/04 «Limitlar»).
  beforeEach(async () => {
    owner = await kit.session('OWNER');
  });

  it('free-quantity product: a second ACTIVE package of one quantity is DUPLICATE_PACKAGE; inactive or fixed-pack is fine', async () => {
    const free = await cat.product({ allowCustomQty: true });
    const dup = await cat.post(
      owner,
      `products/${free.productId}/skus`,
      packageBody({ quantity: 50 }),
    );
    expect(dup.statusCode).toBe(400);
    expect(fields(dup)).toEqual([{ path: 'quantity', code: 'DUPLICATE_PACKAGE' }]);
    const off = await cat.post(
      owner,
      `products/${free.productId}/skus`,
      packageBody({ quantity: 50, isActive: false }),
    );
    expect(dataOf(off)).toMatchObject({ applied: true, sku: { isActive: false } });
    // Switching that one on, or moving another package onto 50, is the same refusal.
    const offId = dataOf<{ sku: { id: string } }>(off).sku.id;
    const on = await cat.patch(owner, `skus/${offId}`, { isActive: true });
    expect(fields(on)).toEqual([{ path: 'quantity', code: 'DUPLICATE_PACKAGE' }]);
    const other = dataOf<{ sku: { id: string } }>(
      await cat.post(owner, `products/${free.productId}/skus`, packageBody({ quantity: 70 })),
    ).sku.id;
    const move = await cat.patch(owner, `skus/${other}`, { quantity: 50 });
    expect(fields(move)).toEqual([{ path: 'quantity', code: 'DUPLICATE_PACKAGE' }]);
    expect(
      await t
        .db()
        .sku.count({ where: { productId: free.productId, quantity: 50, isActive: true } }),
    ).toBe(1);

    const fixed = await cat.product({ allowCustomQty: false });
    const twin = await cat.post(
      owner,
      `products/${fixed.productId}/skus`,
      packageBody({ quantity: 50 }),
    );
    expect(twin.statusCode).toBe(200);
  });

  // Serial sanity only (review m4): the four requests may well run one after another, so this
  // does not prove the lock. The proof is the held-transaction test below.
  it('serial sanity: parallel creates of one quantity leave exactly one active package', async () => {
    const free = await cat.product({ allowCustomQty: true });
    const answers = await Promise.all(
      [1, 2, 3, 4].map(() =>
        cat.post(owner, `products/${free.productId}/skus`, packageBody({ quantity: 300 })),
      ),
    );
    const codes = answers.map((res) => res.statusCode).sort();
    expect(codes).toEqual([200, 400, 400, 400]);
    for (const res of answers.filter((r) => r.statusCode === 400)) {
      expect(fields(res)).toEqual([{ path: 'quantity', code: 'DUPLICATE_PACKAGE' }]);
    }
    expect(
      await t
        .db()
        .sku.count({ where: { productId: free.productId, quantity: 300, isActive: true } }),
    ).toBe(1);
    expect(await cat.audits('SKU_CREATE', free.productId)).toHaveLength(1);
  });

  it('the check runs under the Product lock: a create waits for a transaction holding it, then sees its package', async () => {
    const free = await cat.product({ allowCustomQty: true });
    const held = await heldTransaction(t.db(), async (tx) => {
      // The lock a catalog write takes (another admin's write of this product).
      await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${free.productId} FOR NO KEY UPDATE`;
      await tx.sku.create({
        data: {
          productId: free.productId,
          labelUz: '400',
          labelRu: '400',
          quantity: 400,
          markupBps: 0,
        },
      });
    });
    let finished = false;
    const create = cat
      .post(owner, `products/${free.productId}/skus`, packageBody({ quantity: 400 }))
      .then((res) => {
        finished = true;
        return res;
      });
    const waited = await waitForLockWaiter(
      t.db(),
      '%FROM "Product"%FOR NO KEY UPDATE%',
      () => finished,
    );
    await held.commit();
    const res = await create;
    expect(waited).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(fields(res)).toEqual([{ path: 'quantity', code: 'DUPLICATE_PACKAGE' }]);
  });

  it('the lock is FOR NO KEY UPDATE: while a write holds a product, its category or every product (reorder), their foreign-key inserts go on', async () => {
    const free = await cat.product({ allowCustomQty: true });
    const repo = t.app().get(AdminCatalogWriteRepository);
    const held = await heldTransaction(t.db(), async (tx) => {
      expect(await repo.lockProduct(tx, free.productId)).not.toBeNull();
      expect(await repo.lockCategory(tx, free.categoryId)).toBe(true);
      expect((await repo.lockAllProducts(tx)).some((p) => p.id === free.productId)).toBe(true); // CR m-A
    });
    try {
      // A cost snapshot (the worker's sync; a quote and an order reference the product the same
      // way) and a product of the category: each takes FOR KEY SHARE on the locked row.
      const snapshot = t.db().costSnapshot.create({
        data: {
          productId: free.productId,
          adapter: 'FRAGMENT',
          currency: 'TON',
          basisQuantity: 1,
          costMinor: 1n,
          source: 'e2e-catalog-write',
        },
      });
      expect(await within(snapshot, 5_000)).toBe('done');
      const sibling = t.db().product.create({
        data: {
          slug: `acw-sib-${randomUUID().slice(0, 8)}`,
          categoryId: free.categoryId,
          nameUz: 'ACW qo‘shni',
          nameRu: 'ACW сосед',
          imageUrl: '/assets/products/acw.png',
          deliveryType: 'TG_USERNAME',
          inputSchema: [{ key: 'username', type: 'username' }],
        },
      });
      expect(await within(sibling, 5_000)).toBe('done');
    } finally {
      await held.commit();
    }
  });

  it('free-quantity product: a package outside minQty..maxQty is QUANTITY_RANGE; nothing is written', async () => {
    const free = await cat.product({ allowCustomQty: true }); // range 50..10 000
    for (const quantity of [49, 10_001]) {
      const create = await cat.post(
        owner,
        `products/${free.productId}/skus`,
        packageBody({ quantity }),
      );
      expect(create.statusCode).toBe(400);
      expect(fields(create)).toEqual([{ path: 'quantity', code: 'QUANTITY_RANGE' }]);
      const edit = await cat.patch(owner, `skus/${free.skuId}`, { quantity });
      expect(fields(edit)).toEqual([{ path: 'quantity', code: 'QUANTITY_RANGE' }]);
    }
    expect(await t.db().sku.findMany({ where: { productId: free.productId } })).toEqual([
      expect.objectContaining({ id: free.skuId, quantity: 50 }),
    ]);
    const edge = await cat.post(
      owner,
      `products/${free.productId}/skus`,
      packageBody({ quantity: 10_000 }),
    );
    expect(edge.statusCode).toBe(200);
  });

  describe('Telegram Premium months', () => {
    let premium = { productId: '', skuId: '' };
    beforeAll(async () => {
      const found = await t.db().product.findUnique({
        where: { slug: PREMIUM_PRODUCT_SLUG },
        select: { id: true, skus: { select: { id: true }, take: 1 } },
      });
      if (found !== null && found.skus[0] !== undefined) {
        premium = { productId: found.id, skuId: found.skus[0].id };
      } else if (found === null) {
        const rows = await cat.product({ slug: PREMIUM_PRODUCT_SLUG, quantity: 3 });
        // In an `acw-` category: the kit's purge removes it with the other rows.
        premium = { productId: rows.productId, skuId: rows.skuId };
      }
    });

    it('4 months is PREMIUM_MONTHS on create and on edit; nothing is written', async () => {
      const before = await t.db().sku.findMany({ where: { productId: premium.productId } });
      const create = await cat.post(
        owner,
        `products/${premium.productId}/skus`,
        packageBody({ quantity: 4 }),
      );
      expect(create.statusCode).toBe(400);
      expect(fields(create)).toEqual([{ path: 'quantity', code: 'PREMIUM_MONTHS' }]);
      const edit = await cat.patch(owner, `skus/${premium.skuId}`, { quantity: 4 });
      expect(fields(edit)).toEqual([{ path: 'quantity', code: 'PREMIUM_MONTHS' }]);
      expect(await t.db().sku.findMany({ where: { productId: premium.productId } })).toEqual(
        before,
      );
    });
  });

  describe('reorder', () => {
    let original: { id: string; sort: number }[] = [];
    beforeAll(async () => {
      await cat.product();
      original = await t.db().product.findMany({ select: { id: true, sort: true } });
    });
    // The shared test database keeps its order for the other suites: one transaction.
    t.onClose(async () => {
      const db = t.db();
      await db.$transaction(
        original.map((row) =>
          db.product.updateMany({ where: { id: row.id }, data: { sort: row.sort } }),
        ),
      );
    });

    it('not the full set (missing, foreign, repeated) is refused; the full set applies, then the same is a no-op', async () => {
      const ids = (
        await t.db().product.findMany({ select: { id: true }, orderBy: { id: 'desc' } })
      ).map((row) => row.id);
      // The repeated case below sends one id more: it must still fit the 500-id body.
      if (ids.length >= REORDER_MAX) {
        throw new Error(
          `reorder e2e: ${String(ids.length)} products on the test database, the case needs fewer than ${String(REORDER_MAX)} (clean the *_test database)`,
        );
      }
      const missing = await cat.post(owner, 'products/reorder', { productIds: ids.slice(1) });
      expect(fields(missing)).toEqual([{ path: 'productIds', code: 'PRODUCT_SET_MISMATCH' }]);
      const foreign = await cat.post(owner, 'products/reorder', {
        productIds: [...ids.slice(1), 'cmghost0000000000000000001'],
      });
      expect(fields(foreign)).toEqual([{ path: 'productIds', code: 'PRODUCT_SET_MISMATCH' }]);
      const repeated = await cat.post(owner, 'products/reorder', {
        productIds: [...ids, ids[0]],
      });
      expect(fields(repeated)).toEqual([{ path: 'productIds', code: 'PRODUCT_SET_MISMATCH' }]);

      const key = randomUUID();
      const res = await cat.post(owner, 'products/reorder', { productIds: ids }, key);
      expect(res.statusCode).toBe(200);
      const done = dataOf<{ products: { id: string; sort: number }[]; auditId: string | null }>(
        res,
      );
      expect(done.products).toEqual(ids.map((id, sort) => ({ id, sort })));
      const now = await t.db().product.findMany({ select: { id: true, sort: true } });
      expect(new Map(now.map((row) => [row.id, row.sort]))).toEqual(
        new Map(ids.map((id, sort) => [id, sort])),
      );
      const replay = await cat.post(owner, 'products/reorder', { productIds: ids }, key);
      expect(dataOf(replay)).toMatchObject({ auditId: done.auditId, applied: false });
      const same = await cat.post(owner, 'products/reorder', { productIds: ids });
      expect(dataOf(same)).toMatchObject({ auditId: null, applied: false });
      const rows = await t.db().auditLog.findMany({ where: { id: done.auditId ?? '' } });
      expect(rows[0]).toMatchObject({ action: 'PRODUCT_REORDER', targetType: 'Catalog' });
    });
  });
});
