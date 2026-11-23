import { IDS, ownerActor } from './catalog-write.fake';
import { pkg, refusal, setup } from './catalog-write.setup';

// S8a fix round: the owner decisions of 2026-11-22 (minimum-margin ceiling, QUANTITY_RANGE, the
// adminAction alert on a price or availability change) and review m1 (a repeated reorder id is
// PRODUCT_SET_MISMATCH from the service, not a shape refusal).

const quantityRange = { field: 'quantity', reason: 'QUANTITY_RANGE' };

describe('AdminCatalogWriteService — owner rules (S8a fix)', () => {
  it('reorder: a repeated id is PRODUCT_SET_MISMATCH and nothing moves', async () => {
    const { fake, service } = setup();
    const out = await refusal(service.reorder(ownerActor(), [IDS.other, IDS.other]));
    expect(out).toEqual({
      code: 'VALIDATION_ERROR',
      details: { field: 'productIds', reason: 'PRODUCT_SET_MISMATCH' },
    });
    const triple = await refusal(
      service.reorder(ownerActor(), [IDS.other, IDS.product, IDS.other]),
    );
    expect(triple.details).toEqual({ field: 'productIds', reason: 'PRODUCT_SET_MISMATCH' });
    expect(fake.calls).not.toContain('write');
    expect(fake.audits).toEqual([]);
  });

  it('minimum margin: 10 000 000 000 tiyin (100 mln so‘m) is the ceiling, before any transaction', async () => {
    const { fake, service } = setup();
    const over = await refusal(
      service.updateSku(ownerActor(), IDS.sku, { minMarginTiyin: '10000000001' }),
    );
    expect(over.details).toEqual({ field: 'minMarginTiyin', reason: 'INVALID' });
    const create = await refusal(
      service.createSku(ownerActor(), IDS.product, { ...pkg, minMarginTiyin: '10000000001' }),
    );
    expect(create.details).toEqual({ field: 'minMarginTiyin', reason: 'INVALID' });
    expect(fake.calls).toEqual([]);
    const at = await service.updateSku(ownerActor(), IDS.sku, { minMarginTiyin: '10000000000' });
    expect(at.sku.minMarginTiyin).toBe('10000000000');
  });

  it('free-quantity product: a package outside minQty..maxQty is QUANTITY_RANGE on create and on edit', async () => {
    const { fake, service } = setup(); // range 10..10 000
    for (const quantity of [9, 10_001]) {
      const create = await refusal(
        service.createSku(ownerActor(), IDS.product, { ...pkg, quantity }),
      );
      expect(create.details).toEqual(quantityRange);
      const inactive = await refusal(
        service.createSku(ownerActor(), IDS.product, { ...pkg, quantity, isActive: false }),
      );
      expect(inactive.details).toEqual(quantityRange);
      const edit = await refusal(service.updateSku(ownerActor(), IDS.sku, { quantity }));
      expect(edit.details).toEqual(quantityRange);
    }
    expect(fake.audits).toEqual([]);
    // Both ends are inside.
    expect(
      (await service.createSku(ownerActor(), IDS.product, { ...pkg, quantity: 10 })).applied,
    ).toBe(true);
    expect((await service.updateSku(ownerActor(), IDS.sku, { quantity: 10_000 })).applied).toBe(
      true,
    );
  });

  it('switching on an older package outside the range is QUANTITY_RANGE; switching it off is fine', async () => {
    const { fake, service } = setup();
    fake.skus = fake.skus.map((row) =>
      row.id === IDS.sku2 ? { ...row, quantity: 20_000, isActive: false } : row,
    );
    const on = await refusal(service.updateSku(ownerActor(), IDS.sku2, { isActive: true }));
    expect(on.details).toEqual(quantityRange);
    // A label edit of it does not touch the quantity: allowed.
    expect((await service.updateSku(ownerActor(), IDS.sku2, { labelUz: 'Eski' })).applied).toBe(
      true,
    );
  });

  it('a fixed-pack product, or one without both bounds, takes any quantity', async () => {
    const { fake, service } = setup();
    fake.locked = { ...fake.locked, allowCustomQty: false };
    expect(
      (await service.createSku(ownerActor(), IDS.product, { ...pkg, quantity: 1 })).applied,
    ).toBe(true);
    fake.locked = { ...fake.locked, allowCustomQty: true, maxQty: null };
    expect(
      (await service.createSku(ownerActor(), IDS.product, { ...pkg, quantity: 2 })).applied,
    ).toBe(true);
  });

  describe('owner alert (adminAction) after the commit', () => {
    it('a price edit of a package raises it once, after the commit, with the audit id', async () => {
      const { fake, alerts, service } = setup();
      await service.updateSku(ownerActor(), IDS.sku, { markupBps: 1800 });
      expect(alerts.raised).toEqual([IDS.audit]);
      // The audit row, then the answer's re-read, the commit, and only then the alert.
      expect(fake.calls.slice(-4)).toEqual(['audit', 'readSku', 'commit', 'alert']);
      const margin = setup();
      await margin.service.updateSku(ownerActor(), IDS.sku, { minMarginTiyin: '5000' });
      expect(margin.alerts.raised).toEqual([IDS.audit]);
    });

    it('availability: a package, a product or a route switched off raises it; a new package too', async () => {
      const sku = setup();
      await sku.service.updateSku(ownerActor(), IDS.sku, { isActive: false });
      expect(sku.alerts.raised).toEqual([IDS.audit]);
      const product = setup();
      await product.service.updateProduct(ownerActor(), IDS.product, { isActive: false });
      expect(product.alerts.raised).toEqual([IDS.audit]);
      const route = setup();
      await route.service.updateRoute(ownerActor(), IDS.route, { isEnabled: false });
      expect(route.alerts.raised).toEqual([IDS.audit]);
      const created = setup();
      await created.service.createSku(ownerActor(), IDS.product, pkg);
      expect(created.alerts.raised).toEqual([IDS.audit]);
    });

    it('text, image, order and priority edits raise nothing', async () => {
      const { alerts, service } = setup();
      await service.updateCategory(ownerActor(), IDS.category, { nameUz: 'Yangi' });
      await service.updateProduct(ownerActor(), IDS.product, {
        nameRu: 'Новое',
        imageUrl: '/assets/products/new.png',
        isFeatured: true,
        sort: 4,
      });
      await service.updateSku(ownerActor(), IDS.sku, { labelUz: 'Yangi', tab: 'Tez', sort: 9 });
      await service.updateRoute(ownerActor(), IDS.route, { priority: 3 });
      await service.reorder(ownerActor(), [IDS.other, IDS.product]);
      expect(alerts.raised).toEqual([]);
    });

    it('a no-op or a refused write raises nothing', async () => {
      const { alerts, service } = setup();
      await service.updateSku(ownerActor(), IDS.sku, { markupBps: 1500, isActive: true });
      await refusal(service.updateSku(ownerActor(), IDS.sku, { quantity: 100, isActive: true }));
      await refusal(service.updateSku(ownerActor(), IDS.sku, { markupBps: 10_001 }));
      expect(alerts.raised).toEqual([]);
    });
  });
});
