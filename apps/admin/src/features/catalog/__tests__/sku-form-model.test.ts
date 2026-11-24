import { describe, expect, it } from 'vitest';
import {
  bpsToPercentText,
  emptySkuDraft,
  minMarginToTiyin,
  percentToBps,
  skuCreateBody,
  skuDraftOf,
  skuIssues,
  skuUpdateChange,
} from '../sku-form-model';

const SKU = {
  id: 'mksku000001',
  tab: null,
  labelUz: '50 ⭐',
  labelRu: '50 ⭐',
  quantity: 50,
  supplierSku: null,
  markupBps: 1200,
  minMarginTiyin: '200000',
  isActive: true,
  sort: 0,
};

describe('percent → whole basis points (no float)', () => {
  it('reads "12.5" and "12,5" as 1250', () => {
    expect(percentToBps('12.5')).toBe(1250);
    expect(percentToBps('12,5')).toBe(1250);
  });

  it('keeps hundredths exact where a float would not (1.15 → 115, 0.29 → 29, 4.35 → 435)', () => {
    expect(percentToBps('1.15')).toBe(115);
    expect(percentToBps('0.29')).toBe(29);
    expect(percentToBps('4.35')).toBe(435);
    expect(percentToBps('100')).toBe(10_000);
    expect(percentToBps('0')).toBe(0);
  });

  it('refuses three decimals, above 100 %, signs and garbage', () => {
    for (const raw of ['12.555', '100.01', '101', '-1', '1e2', '', '12.', '.5', 'abc']) {
      expect(percentToBps(raw), raw).toBeNull();
    }
  });

  it('writes basis points back exactly', () => {
    expect(bpsToPercentText(1250)).toBe('12,5');
    expect(bpsToPercentText(1205)).toBe('12,05');
    expect(bpsToPercentText(1200)).toBe('12');
    expect(percentToBps(bpsToPercentText(1205))).toBe(1205);
  });
});

describe('minimum margin so‘m → tiyin', () => {
  it('takes 0, grouped thousands and the 100 mln top; refuses more', () => {
    expect(minMarginToTiyin('0')).toBe('0');
    expect(minMarginToTiyin('2 000')).toBe('200000');
    expect(minMarginToTiyin('1500,50')).toBe('150050');
    expect(minMarginToTiyin('100000000')).toBe('10000000000');
    expect(minMarginToTiyin('100000000,01')).toBeNull();
    expect(minMarginToTiyin('-5')).toBeNull();
  });
});

describe('SKU bodies', () => {
  it('a new package: every field as the API takes it', () => {
    const draft = {
      ...emptySkuDraft(6),
      labelUz: ' 5000 ⭐ ',
      labelRu: '5000 ⭐',
      quantity: '5000',
      markup: '12,5',
      minMargin: '2 000',
    };
    expect(skuCreateBody(draft)).toEqual({
      tab: null,
      labelUz: '5000 ⭐',
      labelRu: '5000 ⭐',
      quantity: 5000,
      supplierSku: null,
      markupBps: 1250,
      minMarginTiyin: '200000',
      isActive: true,
      sort: 6,
    });
  });

  it('names the wrong fields', () => {
    const issues = skuIssues({ ...emptySkuDraft(0), markup: '12.555', quantity: '0' });
    expect(issues).toMatchObject({ labelUz: 'required', quantity: 'invalid', markup: 'invalid' });
  });

  it('an edit sends only what changed', () => {
    const draft = { ...skuDraftOf(SKU), markup: '15' };
    expect(skuUpdateChange(SKU, draft)).toEqual({
      body: { markupBps: 1500 },
      empty: false,
      quantityChanged: false,
    });
  });

  it('an untouched draft is empty; a new quantity is flagged', () => {
    expect(skuUpdateChange(SKU, skuDraftOf(SKU))).toMatchObject({ body: null, empty: true });
    const bigger = skuUpdateChange(SKU, { ...skuDraftOf(SKU), quantity: '75' });
    expect(bigger).toEqual({ body: { quantity: 75 }, empty: false, quantityChanged: true });
  });
});
