import { describe, expect, it } from 'vitest';
import {
  ADMIN_CATALOG_FIELD_ERROR_CODES,
  ADMIN_MAX_MIN_MARGIN_TIYIN,
  ADMIN_PREMIUM_MONTHS,
  PREMIUM_PRODUCT_SLUG,
  isFullProductSet,
  packageQuantityInRange,
  premiumMonthsAllowed,
} from './admin-catalog-rules';

describe('admin catalog rules (S8a)', () => {
  it('names the four domain codes of docs/04', () => {
    expect([...ADMIN_CATALOG_FIELD_ERROR_CODES]).toEqual([
      'DUPLICATE_PACKAGE',
      'PREMIUM_MONTHS',
      'PRODUCT_SET_MISMATCH',
      'QUANTITY_RANGE',
    ]);
  });

  it('the minimum margin is at most 100 mln so‘m (10 000 000 000 tiyin)', () => {
    expect(ADMIN_MAX_MIN_MARGIN_TIYIN).toBe(10_000_000_000n);
  });

  it('a free-quantity package stays inside minQty..maxQty (ends included); otherwise any quantity', () => {
    const free = { allowCustomQty: true, minQty: 50, maxQty: 10_000 };
    expect(packageQuantityInRange(free, 50)).toBe(true);
    expect(packageQuantityInRange(free, 10_000)).toBe(true);
    expect(packageQuantityInRange(free, 49)).toBe(false);
    expect(packageQuantityInRange(free, 10_001)).toBe(false);
    expect(packageQuantityInRange({ ...free, allowCustomQty: false }, 49)).toBe(true);
    // Without both bounds the store sells no typed quantity (customQtyRange null): fixed packs.
    expect(packageQuantityInRange({ ...free, minQty: null }, 1)).toBe(true);
    expect(packageQuantityInRange({ ...free, maxQty: null }, 1)).toBe(true);
  });

  it('Premium: only 3, 6 or 12 months; other products any quantity', () => {
    expect([...ADMIN_PREMIUM_MONTHS]).toEqual([3, 6, 12]);
    for (const months of [3, 6, 12]) {
      expect(premiumMonthsAllowed(PREMIUM_PRODUCT_SLUG, months)).toBe(true);
    }
    for (const months of [1, 2, 4, 9, 24, 36]) {
      expect(premiumMonthsAllowed(PREMIUM_PRODUCT_SLUG, months)).toBe(false);
    }
    expect(premiumMonthsAllowed('telegram-stars', 4)).toBe(true);
    expect(premiumMonthsAllowed('telegram-premium-x', 4)).toBe(true);
  });

  it('the list is frozen', () => {
    expect(Object.isFrozen(ADMIN_PREMIUM_MONTHS)).toBe(true);
    expect(Object.isFrozen(ADMIN_CATALOG_FIELD_ERROR_CODES)).toBe(true);
  });

  it('reorder: exactly every product once, in any order', () => {
    const all = ['a', 'b', 'c'];
    expect(isFullProductSet(all, ['c', 'a', 'b'])).toBe(true);
    expect(isFullProductSet(all, ['a', 'b'])).toBe(false);
    expect(isFullProductSet(all, ['a', 'b', 'c', 'd'])).toBe(false);
    expect(isFullProductSet(all, ['a', 'b', 'b'])).toBe(false);
    expect(isFullProductSet(all, ['a', 'b', 'x'])).toBe(false);
    expect(isFullProductSet([], [])).toBe(true);
  });
});
