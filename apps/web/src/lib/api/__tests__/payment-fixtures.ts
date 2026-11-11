import {
  buildPayLink,
  maskOwnerHint,
  type IntentStatus,
  type LedgerItem,
  type Locale,
  type PayView,
  type PaymentMethodsResponse,
  type TopupIntent,
  type TopupIntentCreated,
  type WalletResponse,
} from '@repo/shared';

// Test-owned wire values for the wallet and top-up endpoints. They stand in for what the real API
// answers (phase 7 S12 proves that against the running API: e2e/support/contract-check). Every
// value is parsed by its shared schema in payments-fixtures.test.ts, so a drift fails there.

export const INTENT_ID = 'cm3intent00000000000000001';
/** A 43-character base64url value: the shape of a real capability token, not a real one. */
export const PAY_TOKEN = `unitPayToken${'A'.repeat(30)}1`;

const BASE_TIYIN = '10000000'; // 100 000 so'm
const PAY_TIYIN = '10037700'; // + a unique 377 so'm extra
const CARD = { bank: 'HUMO', number: '9999000000000001', holderName: 'TEST H.' } as const;
const NOW = new Date('2026-11-05T10:00:00.000Z');
const IN_30_MIN = new Date(NOW.getTime() + 30 * 60_000).toISOString();

export const WALLET: WalletResponse = { balanceTiyin: '12550000', coins: '0', currency: 'UZS' };

export const LEDGER: LedgerItem[] = [
  {
    id: 'cm3ledger0000000000000002',
    kind: 'PURCHASE',
    amountTiyin: '-8540000',
    createdAt: '2026-11-05T09:00:00.000Z',
    orderId: 'cm3order00000000000000001',
    paymentId: null,
  },
  {
    id: 'cm3ledger0000000000000001',
    kind: 'TOPUP',
    amountTiyin: '15000000',
    createdAt: '2026-11-05T08:00:00.000Z',
    orderId: null,
    paymentId: 'cm3payment00000000000001',
  },
];

export const METHODS: PaymentMethodsResponse = [
  {
    code: 'P2P_CARD',
    available: true,
    banks: [
      { bank: 'HUMO', available: true },
      { bank: 'UZCARD', available: false },
    ],
    minTiyin: '500000',
    maxTiyin: '200000000',
    stepTiyin: '100000',
  },
];

export function intentCreated(locale?: Locale): TopupIntentCreated {
  return {
    intentId: INTENT_ID,
    status: 'PENDING',
    baseAmountTiyin: BASE_TIYIN,
    payAmountTiyin: PAY_TIYIN,
    card: CARD,
    expiresAt: IN_30_MIN,
    redirectUrl: buildPayLink('https://example.test', INTENT_ID, PAY_TOKEN, locale),
    currency: 'UZS',
  };
}

export function intent(status: IntentStatus): TopupIntent {
  const paid = status === 'PAID';
  return {
    intentId: INTENT_ID,
    status,
    baseAmountTiyin: BASE_TIYIN,
    payAmountTiyin: PAY_TIYIN,
    card: status === 'PENDING' ? CARD : null,
    expiresAt: IN_30_MIN,
    paidAt: paid ? NOW.toISOString() : null,
    creditedTiyin: paid ? PAY_TIYIN : null,
    currency: 'UZS',
  };
}

export function payView(status: IntentStatus): PayView {
  const { baseAmountTiyin, payAmountTiyin, card, expiresAt } = intent(status);
  return {
    intentId: INTENT_ID,
    status,
    baseAmountTiyin,
    payAmountTiyin,
    card,
    expiresAt,
    ownerHint: maskOwnerHint('Aziz', 'test_user_1'),
    currency: 'UZS',
  };
}
