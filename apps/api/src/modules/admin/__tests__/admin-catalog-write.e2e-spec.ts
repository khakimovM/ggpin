import { randomUUID } from 'node:crypto';
import {
  AdminCategoryUpdateResponseSchema,
  AdminProductUpdateResponseSchema,
  AdminRouteUpdateResponseSchema,
  AdminSkuResponseSchema,
} from '@repo/shared';
import { catalogKit, packageBody } from './admin-catalog-write.e2e-kit';
import { useAdminE2e } from './admin-e2e.harness';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S8a: the catalog writes (docs/04 «Katalog», D-63 (8)) on the real app: roles, the
// audit with only the changed fields, the no-op, the Idempotency-Key replay and 409, and the
// shape refusals (400) of the shared schemas.
const t = useAdminE2e();
const kit = adminWriteKit(t);
const cat = catalogKit(t);

describe('admin catalog writes (S8a)', () => {
  let owner: Session;
  // A session per test: the admin write limit is 30 a minute per session (docs/04 «Limitlar»).
  beforeEach(async () => {
    owner = await kit.session('OWNER');
  });

  it('OPERATOR and SUPPORT get 404 on all six routes, and nothing is written', async () => {
    const rows = await cat.product();
    const before = await t.db().product.findUniqueOrThrow({ where: { id: rows.productId } });
    for (const role of ['OPERATOR', 'SUPPORT'] as const) {
      const who = await kit.session(role);
      const answers = await Promise.all([
        cat.patch(who, `categories/${rows.categoryId}`, { sort: 7 }),
        cat.patch(who, `products/${rows.productId}`, { nameUz: 'Boshqa nom' }),
        cat.post(who, 'products/reorder', { productIds: [rows.productId] }),
        cat.post(who, `products/${rows.productId}/skus`, packageBody()),
        cat.patch(who, `skus/${rows.skuId}`, { markupBps: 0 }),
        cat.patch(who, `routes/${rows.routeId}`, { isEnabled: false }),
      ]);
      expect(answers.map((res) => res.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
    }
    expect(await t.db().product.findUniqueOrThrow({ where: { id: rows.productId } })).toEqual(
      before,
    );
    expect(await t.db().sku.count({ where: { productId: rows.productId } })).toBe(1);
    const targets = [rows.categoryId, rows.productId, rows.skuId, rows.routeId, 'products'];
    expect(
      await t.db().auditLog.count({
        where: { targetId: { in: targets }, createdAt: { gte: before.updatedAt } },
      }),
    ).toBe(0);
  });

  it('product: only the changed fields are audited; replay; 409; a no-op writes nothing', async () => {
    const rows = await cat.product();
    const key = randomUUID();
    const body = { nameUz: 'Yangi nom', isActive: false, imageUrl: '/assets/products/acw.png' };
    const res = await cat.patch(owner, `products/${rows.productId}`, body, key);
    expect(res.statusCode).toBe(200);
    const done = AdminProductUpdateResponseSchema.parse(dataOf(res));
    expect(done).toMatchObject({ applied: true, product: { nameUz: 'Yangi nom' } });
    const [row, ...more] = await cat.audits('PRODUCT_UPDATE', rows.productId);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      id: done.auditId,
      actorType: 'ADMIN',
      actorId: owner.admin.id,
      targetType: 'Product',
      reason: null,
    });
    expect(row?.before).toEqual({ nameUz: expect.stringMatching(/^ACW mahsulot /) as unknown });
    expect(row?.after).toMatchObject({ nameUz: 'Yangi nom', adminRole: 'OWNER' });
    expect(Object.keys(row?.after ?? {}).sort()).toEqual(
      ['adminRole', 'nameUz', 'requestHash', 'sessionId'].sort(),
    );

    const again = await cat.patch(owner, `products/${rows.productId}`, body, key);
    expect(dataOf(again)).toMatchObject({ auditId: done.auditId, applied: false });
    const other = await cat.patch(owner, `products/${rows.productId}`, { nameUz: 'Uchinchi' }, key);
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).code).toBe('IDEMPOTENCY_CONFLICT');

    const noop = await cat.patch(owner, `products/${rows.productId}`, body);
    expect(dataOf(noop)).toMatchObject({ auditId: null, applied: false });
    expect(await cat.audits('PRODUCT_UPDATE', rows.productId)).toHaveLength(1);
  });

  it('category, package and route: the GET shapes, the reason when given', async () => {
    const rows = await cat.product();
    const reason = { reason: 'Katalog tartibi yangilandi' };
    const category = await cat.patch(owner, `categories/${rows.categoryId}`, {
      nameRu: 'Новое имя',
      ...reason,
    });
    expect(AdminCategoryUpdateResponseSchema.parse(dataOf(category))).toMatchObject({
      category: { id: rows.categoryId, nameRu: 'Новое имя', productsCount: 1 },
      applied: true,
    });
    const [catRow] = await cat.audits('CATEGORY_UPDATE', rows.categoryId);
    expect(catRow).toMatchObject({ targetType: 'Category', reason: reason.reason });

    const sku = await cat.patch(owner, `skus/${rows.skuId}`, {
      markupBps: 2000,
      minMarginTiyin: '150000',
      tab: 'Tezkor',
    });
    expect(AdminSkuResponseSchema.parse(dataOf(sku))).toMatchObject({
      sku: { id: rows.skuId, markupBps: 2000, minMarginTiyin: '150000', tab: 'Tezkor' },
      applied: true,
    });
    const [skuRow] = await cat.audits('SKU_UPDATE', rows.skuId);
    expect(skuRow?.before).toEqual({ markupBps: 1500, minMarginTiyin: '0', tab: null });

    const route = await cat.patch(owner, `routes/${rows.routeId}`, { isEnabled: false });
    expect(AdminRouteUpdateResponseSchema.parse(dataOf(route))).toMatchObject({
      route: { id: rows.routeId, isEnabled: false, priority: 1 },
      applied: true,
    });

    const created = await cat.post(owner, `products/${rows.productId}/skus`, packageBody());
    const sku2 = AdminSkuResponseSchema.parse(dataOf(created));
    expect(sku2).toMatchObject({ sku: { quantity: 75, supplierSku: null }, applied: true });
    const [createRow] = await cat.audits('SKU_CREATE', rows.productId);
    expect(createRow?.after).toMatchObject({ skuId: sku2.sku.id, quantity: 75, markupBps: 1200 });
  });

  it('a price or availability change queues the owners’ adminAction alert; a text edit or a replay does not', async () => {
    const rows = await cat.product();
    const key = randomUUID();
    const priced = dataOf<{ auditId: string }>(
      await cat.patch(owner, `skus/${rows.skuId}`, { markupBps: 1700 }, key),
    );
    expect(await kit.alerts('adminAction', priced.auditId)).toBe(1);
    await cat.patch(owner, `skus/${rows.skuId}`, { markupBps: 1700 }, key); // replay
    expect(await kit.alerts('adminAction', priced.auditId)).toBe(1);
    const off = dataOf<{ auditId: string }>(
      await cat.patch(owner, `routes/${rows.routeId}`, { isEnabled: false }),
    );
    expect(await kit.alerts('adminAction', off.auditId)).toBe(1);

    const renamed = dataOf<{ auditId: string }>(
      await cat.patch(owner, `products/${rows.productId}`, { nameUz: 'Faqat nom' }),
    );
    const label = dataOf<{ auditId: string }>(
      await cat.patch(owner, `skus/${rows.skuId}`, { labelRu: 'Только текст' }),
    );
    expect(await kit.alerts('adminAction', renamed.auditId)).toBe(0);
    expect(await kit.alerts('adminAction', label.auditId)).toBe(0);
  });

  it('a created package replays to itself (one row, one audit)', async () => {
    const rows = await cat.product();
    const key = randomUUID();
    const body = packageBody({ quantity: 90 });
    const first = dataOf<{ sku: { id: string }; auditId: string }>(
      await cat.post(owner, `products/${rows.productId}/skus`, body, key),
    );
    const again = await cat.post(owner, `products/${rows.productId}/skus`, body, key);
    expect(dataOf(again)).toMatchObject({
      sku: { id: first.sku.id },
      auditId: first.auditId,
      applied: false,
    });
    expect(await t.db().sku.count({ where: { productId: rows.productId, quantity: 90 } })).toBe(1);
  });

  it('shape refusals are 400 and write nothing; unknown ids are 404', async () => {
    const rows = await cat.product();
    const path = `products/${rows.productId}`;
    const bad = [
      { imageUrl: 'https://cdn.example.test/p.png' },
      { imageUrl: '/assets/../secret.png' },
      { imageUrl: '/assets/products/p.png?x=1' },
      { nameUz: 'abc‮def' },
      { nameUz: 'line\nbreak' },
      { descriptionUz: 'tab\there' },
      {},
      { reason: 'faqat sabab, maydon yo‘q' },
      { slug: 'new-slug' },
    ];
    for (const body of bad) {
      expect((await cat.patch(owner, path, body)).statusCode).toBe(400);
    }
    const skuBad = [
      { markupBps: 10_001 },
      { markupBps: -1 },
      { markupBps: 1.5 },
      { minMarginTiyin: '-1' },
      { minMarginTiyin: '10000000001' }, // above 100 mln so‘m (owner 2026-11-22)
      { minMarginTiyin: '1.5' },
      { minMarginTiyin: 5 },
      { quantity: 0 },
    ];
    for (const body of skuBad) {
      expect((await cat.patch(owner, `skus/${rows.skuId}`, body)).statusCode).toBe(400);
    }
    expect(
      (await cat.post(owner, `products/${rows.productId}/skus`, packageBody({ markupBps: 10_001 })))
        .statusCode,
    ).toBe(400);
    const noKey = await cat.patch(owner, path, { nameUz: 'Kalitsiz' }, null);
    expect(noKey.statusCode).toBe(400);
    expect(
      await t.db().auditLog.count({ where: { targetId: { in: [rows.productId, rows.skuId] } } }),
    ).toBe(0);

    const ghost = 'cmghost0000000000000000001';
    expect((await cat.patch(owner, `skus/${ghost}`, { sort: 1 })).statusCode).toBe(404);
    expect((await cat.patch(owner, `routes/${ghost}`, { priority: 1 })).statusCode).toBe(404);
    expect((await cat.patch(owner, `categories/${ghost}`, { sort: 1 })).statusCode).toBe(404);
    expect((await cat.post(owner, `products/${ghost}/skus`, packageBody())).statusCode).toBe(404);
    expect((await cat.patch(owner, 'skus/not-an-id!', { sort: 1 })).statusCode).toBe(404);
  });
});
