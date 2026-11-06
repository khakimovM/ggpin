import type { LedgerItem, WalletResponse } from '@repo/shared';

// Dev mock data for the `wallet` group. Every value passes the shared schema (see the
// fixtures test); amounts are tiyin strings, never numbers.

export const MOCK_WALLET: WalletResponse = {
  balanceTiyin: '12550000', // 125 500 so‘m
  coins: '150',
  currency: 'UZS',
};

/** Scenario `insufficient`: a balance that cannot pay the mock quote. */
export const MOCK_WALLET_LOW: WalletResponse = {
  balanceTiyin: '1000000', // 10 000 so‘m
  coins: '0',
  currency: 'UZS',
};

export function mockLedger(now: Date): LedgerItem[] {
  const ago = (minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString();
  return [
    {
      id: 'ledger_mock_4',
      kind: 'REFERRAL_BONUS',
      amountTiyin: '8500',
      createdAt: ago(30),
      orderId: null,
      paymentId: null,
    },
    {
      id: 'ledger_mock_3',
      kind: 'PURCHASE',
      amountTiyin: '-8540000',
      createdAt: ago(120),
      orderId: 'order_mock_1',
      paymentId: null,
    },
    {
      id: 'ledger_mock_2',
      kind: 'REFUND',
      amountTiyin: '3705000',
      createdAt: ago(60 * 26),
      orderId: 'order_mock_0',
      paymentId: null,
    },
    {
      id: 'ledger_mock_1',
      kind: 'TOPUP',
      amountTiyin: '15000000',
      createdAt: ago(60 * 50),
      orderId: null,
      paymentId: 'intent_mock_1',
    },
  ];
}
