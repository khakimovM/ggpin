import type { Quote } from '@repo/db';
import { toQuoteResponse } from '../entities/quote.mapper';
import { NOW } from './quotes.fixtures';

describe('toQuoteResponse', () => {
  it('drops every cost-side column of the row, and the photo URL of the recipient', () => {
    const row = {
      id: 'q9',
      userId: 'u1',
      productId: 'p1',
      skuId: 's50',
      quantity: 50,
      recipient: { username: 'aziz_k', displayName: 'Aziz', photoUrl: 'https://x.test/a.png' },
      costCurrency: 'TON',
      costMinor: 1n,
      fxRateId: 'fx',
      costSnapshotId: 'snap',
      priceTiyin: 700_000n,
      maxCostMinor: 2n,
      discountCodeId: null,
      expiresAt: NOW,
      usedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as Quote;
    const out = toQuoteResponse(row);
    expect(Object.keys(out).sort()).toEqual([
      'currency',
      'discountTiyin',
      'expiresAt',
      'priceTiyin',
      'quoteId',
      'recipient',
      'totalTiyin',
    ]);
    expect(Object.keys(out.recipient).sort()).toEqual(['displayName', 'username']);
    expect(JSON.stringify(out)).not.toMatch(/snap|"fx"|maxCost|costMinor/);
  });

  // The total goes through the shared money module, which refuses a negative price instead of
  // printing it, so a corrupt row can never reach a client as a negative amount to pay.
  it('refuses a row whose price is negative', () => {
    const row = {
      id: 'q9',
      priceTiyin: -1n,
      expiresAt: NOW,
      recipient: { username: 'aziz_k', displayName: 'Aziz' },
    } as unknown as Quote;
    expect(() => toQuoteResponse(row)).toThrow();
  });
});
