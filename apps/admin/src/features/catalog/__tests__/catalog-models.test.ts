import { ApiError, adminFieldCode } from '../../../lib/api/errors';
import { describe, expect, it } from 'vitest';
import { productDetailFixture } from '../../../lib/api/mock/fixtures-catalog';
import { enumKey, eventActorKey } from '../../../lib/enum-text';
import { actionErrorKey } from '../../common/action-error-text';
import { categoryChange } from '../CategoryEditDialog';
import { productChange, productDraftOf } from '../product-edit-diff';
import { moveBy, moveOnto, sameOrder, savedOrder } from '../reorder-model';
import { routeChange } from '../RouteEditDialog';

const product = productDetailFixture('mkprod000001');
if (product === undefined) throw new Error('fixture');

describe('product diff (only changed fields)', () => {
  it('nothing changed → no body', () => {
    expect(productChange(product, productDraftOf(product))).toEqual({
      body: null,
      fields: [],
      invalid: [],
    });
  });

  it('one name and the switch → exactly those two', () => {
    const draft = { ...productDraftOf(product), nameRu: 'Звёзды Telegram', isFeatured: false };
    const change = productChange(product, draft);
    expect(change.body).toEqual({ nameRu: 'Звёзды Telegram', isFeatured: false });
    expect(change.fields).toEqual(['nameRu', 'isFeatured']);
  });

  it('a blank description becomes null; an empty name is refused', () => {
    expect(
      productChange(product, { ...productDraftOf(product), descriptionRu: '  ' }).body,
    ).toEqual({ descriptionRu: null });
    const bad = productChange(product, { ...productDraftOf(product), nameUz: '', imageUrl: 'x' });
    expect(bad.body).toBeNull();
    expect(bad.invalid).toEqual(['nameUz', 'imageUrl']);
  });
});

describe('route and category diffs', () => {
  const route = product.routes[0];
  if (route === undefined) throw new Error('fixture');
  it('route: priority and switch only when changed', () => {
    expect(routeChange(route, { priority: '0', isEnabled: true })).toBeNull();
    expect(routeChange(route, { priority: '5', isEnabled: true })).toEqual({ priority: 5 });
    expect(routeChange(route, { priority: '1001', isEnabled: false })).toBeNull();
  });

  it('category: changed fields only', () => {
    const category = {
      id: 'mkcat000001',
      slug: 'telegram',
      nameUz: 'Telegram',
      nameRu: 'Telegram',
      sort: 0,
      productsCount: 2,
    };
    expect(categoryChange(category, { nameUz: 'Telegram', nameRu: 'Телеграм', sort: '0' })).toEqual(
      {
        nameRu: 'Телеграм',
      },
    );
    expect(
      categoryChange(category, { nameUz: 'Telegram', nameRu: 'Telegram', sort: '0' }),
    ).toBeNull();
  });
});

describe('reorder model', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('moves by buttons / Alt+arrows, clamped', () => {
    expect(moveBy(ids, 2, -1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveBy(ids, 0, -1)).toEqual(ids);
    expect(moveBy(ids, 3, 1)).toEqual(ids);
  });

  it('drag onto another row: rows between shift', () => {
    expect(moveOnto(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveOnto(ids, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('saved order by sort; full set kept', () => {
    expect(
      savedOrder([
        { id: 'x', sort: 2 },
        { id: 'y', sort: 0 },
        { id: 'z', sort: 1 },
      ]),
    ).toEqual(['y', 'z', 'x']);
    const moved = moveOnto(ids, 'b', 'd');
    expect([...moved].sort()).toEqual(ids);
    expect(sameOrder(moved, ids)).toBe(false);
  });
});

describe('catalog field codes (CR m2)', () => {
  const refusal = (path: string, code: string) =>
    new ApiError({
      status: 400,
      code: 'VALIDATION_ERROR',
      fromServer: true,
      details: { fields: [{ path, code }] },
    });

  it.each([
    ['quantity', 'DUPLICATE_PACKAGE', 'admin.fieldErrors.duplicatePackage'],
    ['quantity', 'PREMIUM_MONTHS', 'admin.fieldErrors.premiumMonths'],
    ['quantity', 'QUANTITY_RANGE', 'admin.fieldErrors.quantityRange'],
    ['productIds', 'PRODUCT_SET_MISMATCH', 'admin.fieldErrors.productSetMismatch'],
    ['quantity', 'QTY_OUT_OF_RANGE', 'admin.fieldErrors.qtyOutOfRange'],
  ])('%s %s is named, never unknown', (path, code, key) => {
    expect(adminFieldCode(refusal(path, code), path)).toBe(code);
    expect(actionErrorKey(refusal(path, code))).toBe(key);
  });

  it('an unknown code stays unknown', () => {
    expect(adminFieldCode(refusal('quantity', 'SOMETHING_NEW'), 'quantity')).toBeUndefined();
    expect(actionErrorKey(refusal('quantity', 'SOMETHING_NEW'))).toBe('admin.fieldErrors.unknown');
  });
});

describe('enum words', () => {
  it('maps known values and falls back to one general text', () => {
    expect(enumKey('orderStatus', 'NEEDS_REVIEW')).toBe('admin.enums.orderStatus.needsReview');
    expect(enumKey('auditAction', 'SKU_UPDATE')).toBe('admin.enums.auditAction.skuUpdate');
    expect(enumKey('orderReason', 'SUPPLIER_TIMEOUT')).toBe('admin.enums.unknown');
    expect(eventActorKey('ADMIN:cmadmin01')).toBe('admin.enums.eventActor.admin');
    expect(eventActorKey('worker')).toBe('admin.enums.eventActor.worker');
  });
});
