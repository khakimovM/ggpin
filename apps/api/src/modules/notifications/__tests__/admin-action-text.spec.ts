import { adminActionText } from '../admin-action-text';

// The adminAction alert's `{action}` (S10 fix round, audit L-2): an FX_SET names the pair, the
// previous and the new rate and the move; anything else, or a row that does not fit, is the code.

const fx = (before: unknown, after: unknown) => ({ action: 'FX_SET', before, after });

describe('adminActionText', () => {
  it('FX_SET: pair, previous -> new rate and the move in bps, in both languages', () => {
    const audit = fx(
      { previous: { id: 'r0', rate: '12800', source: 'manual' } },
      { pair: 'USDT_UZS', rate: '13000' },
    );
    expect(adminActionText(audit)).toBe('FX_SET USDT_UZS: 12800 → 13000 (157 bps)');
    expect(adminActionText(audit, 'ru')).toBe('FX_SET USDT_UZS: 12800 → 13000 (157 б.п.)');
  });

  it('FX_SET without a previous rate shows dashes', () => {
    expect(adminActionText(fx({ previous: null }, { pair: 'TON_USDT', rate: '3.1' }))).toBe(
      'FX_SET TON_USDT: - → 3.1 (- bps)',
    );
  });

  it('any other action, or an FX_SET row that does not fit, is the bare code', () => {
    expect(adminActionText({ action: 'ORDER_RETRY', before: {}, after: {} })).toBe('ORDER_RETRY');
    expect(adminActionText(fx({}, { pair: 'TON_UZS', rate: '1' }))).toBe('FX_SET');
    expect(adminActionText(fx({}, { pair: 'USDT_UZS', rate: '<b>' }))).toBe('FX_SET');
    expect(adminActionText(fx(null, null))).toBe('FX_SET');
  });
});
