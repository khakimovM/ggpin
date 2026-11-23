import { IDS, ownerActor } from './catalog-write.fake';
import { pkg, refusal, setup } from './catalog-write.setup';

describe('AdminCatalogWriteService (S8a)', () => {
  it('a change writes only the changed fields, with the actor facts, in one transaction after the lock', async () => {
    const { fake, service } = setup();
    const done = await service.updateCategory(ownerActor(), IDS.category, {
      nameUz: 'Telegram',
      nameRu: 'Телеграм Stars',
      sort: 0,
    });
    expect(done).toMatchObject({ auditId: IDS.audit, applied: true });
    expect(done.category.nameRu).toBe('Телеграм Stars');
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      id: IDS.audit,
      actorId: IDS.admin,
      action: 'CATEGORY_UPDATE',
      targetType: 'Category',
      targetId: IDS.category,
      before: { nameRu: 'Телеграм' },
      after: { nameRu: 'Телеграм Stars', adminRole: 'OWNER', sessionId: IDS.session },
      reason: undefined,
    });
    expect(Object.keys(fake.audits[0]?.before ?? {})).toEqual(['nameRu']);
    // A name edit raises no owner alert: nothing follows the commit.
    expect(fake.calls).toEqual(['begin', 'lockCategory', 'write', 'audit', 'commit']);
  });

  it('no change: nothing written, auditId null, applied false', async () => {
    const { fake, service } = setup();
    const done = await service.updateCategory(ownerActor(), IDS.category, { sort: 0 });
    expect(done).toMatchObject({ auditId: null, applied: false });
    expect(fake.audits).toEqual([]);
    expect(fake.calls).not.toContain('write');
  });

  it('a reason is trimmed into the audit row', async () => {
    const { fake, service } = setup();
    await service.updateCategory(ownerActor(), IDS.category, {
      sort: 5,
      reason: 'Yangi tartib bo‘yicha',
    });
    expect(fake.audits[0]?.reason).toBe('Yangi tartib bo‘yicha');
  });

  it('an admin no longer OWNER (re-read in the tx) is refused 404 and nothing is written', async () => {
    const { fake, service } = setup();
    fake.admin = { role: 'OPERATOR', isActive: true };
    const out = await refusal(service.updateCategory(ownerActor(), IDS.category, { sort: 9 }));
    expect(out.code).toBe('NOT_FOUND');
    fake.admin = { role: 'OWNER', isActive: false };
    expect(
      (await refusal(service.updateCategory(ownerActor(), IDS.category, { sort: 9 }))).code,
    ).toBe('NOT_FOUND');
    expect(fake.audits).toEqual([]);
  });

  it('unknown category, package, route: 404', async () => {
    const { service } = setup();
    const id = 'cmnope0000000000000000001';
    expect((await refusal(service.updateCategory(ownerActor(), id, { sort: 1 }))).code).toBe(
      'NOT_FOUND',
    );
    expect((await refusal(service.updateSku(ownerActor(), id, { sort: 1 }))).code).toBe(
      'NOT_FOUND',
    );
    expect((await refusal(service.updateRoute(ownerActor(), id, { priority: 1 }))).code).toBe(
      'NOT_FOUND',
    );
    expect((await refusal(service.createSku(ownerActor(), id, pkg))).code).toBe('NOT_FOUND');
  });

  it('reorder: not the full set is PRODUCT_SET_MISMATCH; the same order is a no-op; a move audits only moved rows', async () => {
    const { fake, service } = setup();
    const missing = await refusal(service.reorder(ownerActor(), [IDS.product]));
    expect(missing).toEqual({
      code: 'VALIDATION_ERROR',
      details: { field: 'productIds', reason: 'PRODUCT_SET_MISMATCH' },
    });
    const same = await service.reorder(ownerActor(), [IDS.product, IDS.other]);
    expect(same).toMatchObject({ auditId: null, applied: false });
    const moved = await service.reorder(ownerActor(), [IDS.other, IDS.product]);
    expect(moved.products).toEqual([
      { id: IDS.other, sort: 0 },
      { id: IDS.product, sort: 1 },
    ]);
    expect(fake.audits[0]).toMatchObject({
      action: 'PRODUCT_REORDER',
      targetType: 'Catalog',
      targetId: 'products',
      before: {
        sorts: [
          { id: IDS.other, sort: 1 },
          { id: IDS.product, sort: 0 },
        ],
      },
    });
  });

  it('new package: a second ACTIVE one of the same quantity on a free-quantity product is DUPLICATE_PACKAGE (under the lock)', async () => {
    const { fake, service } = setup();
    const dup = await refusal(
      service.createSku(ownerActor(), IDS.product, { ...pkg, quantity: 50 }),
    );
    expect(dup.details).toEqual({ field: 'quantity', reason: 'DUPLICATE_PACKAGE' });
    expect(fake.calls.indexOf('lockProduct')).toBeLessThan(fake.calls.indexOf('countTwins'));
    // Inactive: allowed. A fixed-pack product: allowed.
    const off = await service.createSku(ownerActor(), IDS.product, {
      ...pkg,
      quantity: 50,
      isActive: false,
    });
    expect(off.applied).toBe(true);
    fake.locked = { ...fake.locked, allowCustomQty: false };
    expect(
      (await service.createSku(ownerActor(), IDS.product, { ...pkg, quantity: 100 })).applied,
    ).toBe(true);
  });

  it('new package: the whole row is audited, the target is the product, money as a string', async () => {
    const { fake, service } = setup();
    const done = await service.createSku(ownerActor(), IDS.product, {
      ...pkg,
      minMarginTiyin: '250000',
    });
    expect(done.sku).toMatchObject({ quantity: 75, minMarginTiyin: '250000', tab: null });
    expect(fake.audits[0]).toMatchObject({
      action: 'SKU_CREATE',
      targetType: 'Product',
      targetId: IDS.product,
      before: {},
      after: { skuId: done.sku.id, minMarginTiyin: '250000', markupBps: 1200, quantity: 75 },
    });
  });

  it('Telegram Premium: months other than 3, 6, 12 are PREMIUM_MONTHS, on create and on edit', async () => {
    const { fake, service } = setup();
    fake.locked = { ...fake.locked, slug: 'telegram-premium', allowCustomQty: false };
    const create = await refusal(
      service.createSku(ownerActor(), IDS.product, { ...pkg, quantity: 4 }),
    );
    expect(create.details).toEqual({ field: 'quantity', reason: 'PREMIUM_MONTHS' });
    const edit = await refusal(service.updateSku(ownerActor(), IDS.sku, { quantity: 4 }));
    expect(edit.details).toEqual({ field: 'quantity', reason: 'PREMIUM_MONTHS' });
    expect(
      (await service.createSku(ownerActor(), IDS.product, { ...pkg, quantity: 6 })).applied,
    ).toBe(true);
  });

  it('package edit: switching on a twin quantity is DUPLICATE_PACKAGE; a price edit is diffed (bigint as string)', async () => {
    const { fake, service } = setup();
    fake.skus = fake.skus.map((row) =>
      row.id === IDS.sku2 ? { ...row, quantity: 50, isActive: false } : row,
    );
    const on = await refusal(service.updateSku(ownerActor(), IDS.sku2, { isActive: true }));
    expect(on.details).toEqual({ field: 'quantity', reason: 'DUPLICATE_PACKAGE' });
    const priced = await service.updateSku(ownerActor(), IDS.sku, {
      markupBps: 1500,
      minMarginTiyin: '100',
    });
    expect(priced).toMatchObject({
      applied: true,
      sku: { minMarginTiyin: '100', markupBps: 1500 },
    });
    expect(fake.audits[0]?.before).toEqual({ minMarginTiyin: '0' });
    expect(fake.audits[0]?.after).toMatchObject({ minMarginTiyin: '100' });
    expect(fake.audits[0]?.after).not.toHaveProperty('markupBps');
  });

  it('money bounds are checked again in the service (fail closed), before any transaction', async () => {
    const { fake, service } = setup();
    const markup = await refusal(service.updateSku(ownerActor(), IDS.sku, { markupBps: 10_001 }));
    expect(markup.details).toEqual({ field: 'markupBps', reason: 'INVALID' });
    const margin = await refusal(
      service.updateSku(ownerActor(), IDS.sku, { minMarginTiyin: '-1' }),
    );
    expect(margin.details).toEqual({ field: 'minMarginTiyin', reason: 'INVALID' });
    expect(fake.calls).toEqual([]);
  });

  it('route: priority change audited; the same value is a no-op', async () => {
    const { fake, service } = setup();
    expect(await service.updateRoute(ownerActor(), IDS.route, { priority: 1 })).toMatchObject({
      auditId: null,
      applied: false,
    });
    const done = await service.updateRoute(ownerActor(), IDS.route, {
      priority: 2,
      isEnabled: true,
    });
    expect(done.route).toMatchObject({ id: IDS.route, priority: 2, health: 'UNKNOWN' });
    expect(fake.audits[0]).toMatchObject({
      action: 'ROUTE_UPDATE',
      targetType: 'ProductRoute',
      before: { priority: 1 },
    });
  });
});
