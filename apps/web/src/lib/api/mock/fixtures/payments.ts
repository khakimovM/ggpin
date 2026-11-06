import {
  TOPUP_DEFAULTS,
  buildPayLink,
  maskOwnerHint,
  type IntentStatus,
  type Locale,
  type PayView,
  type PaymentMethodsResponse,
  type TopupIntent,
  type TopupIntentCreated,
} from '@repo/shared';

export const MOCK_INTENT_ID = 'intent_mock_1';
/** A 43-character base64url value: the shape of a real capability token, not a real one. */
export const MOCK_PAY_TOKEN = 'mockpaytoken'.padEnd(43, 'x');

const BASE_TIYIN = '10000000'; // 100 000 so‘m
const PAY_TIYIN = '10037700'; // base + a unique 377 so‘m extra (the amount to match on the bank side)
const CARD = { bank: 'HUMO', number: '9999000000000001', holderName: 'ALISHER K.' } as const;
const TTL_MS = TOPUP_DEFAULTS.INTENT_TTL_SEC * 1000;

export const MOCK_PAYMENT_METHODS: PaymentMethodsResponse = [
  {
    code: 'P2P_CARD',
    available: true,
    banks: [
      { bank: 'HUMO', available: true },
      { bank: 'UZCARD', available: true },
    ],
    minTiyin: TOPUP_DEFAULTS.MIN_TIYIN.toString(),
    maxTiyin: TOPUP_DEFAULTS.MAX_TIYIN.toString(),
    stepTiyin: TOPUP_DEFAULTS.STEP_TIYIN.toString(),
  },
];

export function mockIntentCreated(options: {
  siteUrl: string;
  now: Date;
  locale?: Locale;
  baseTiyin?: string;
  payTiyin?: string;
}): TopupIntentCreated {
  return {
    intentId: MOCK_INTENT_ID,
    status: 'PENDING',
    baseAmountTiyin: options.baseTiyin ?? BASE_TIYIN,
    payAmountTiyin: options.payTiyin ?? PAY_TIYIN,
    card: CARD,
    expiresAt: new Date(options.now.getTime() + TTL_MS).toISOString(),
    // Token in the fragment, only the language in the query (D-39).
    redirectUrl: buildPayLink(options.siteUrl, MOCK_INTENT_ID, MOCK_PAY_TOKEN, options.locale),
    currency: 'UZS',
  };
}

export function mockIntent(status: IntentStatus, now: Date, id = MOCK_INTENT_ID): TopupIntent {
  const paid = status === 'PAID';
  return {
    intentId: id,
    status,
    baseAmountTiyin: BASE_TIYIN,
    payAmountTiyin: PAY_TIYIN,
    // The card is shown only while the request waits for money.
    card: status === 'PENDING' ? CARD : null,
    expiresAt: new Date(now.getTime() + (status === 'EXPIRED' ? -60_000 : TTL_MS)).toISOString(),
    paidAt: paid ? now.toISOString() : null,
    creditedTiyin: paid ? PAY_TIYIN : null,
    currency: 'UZS',
  };
}

export function mockPayView(status: IntentStatus, now: Date, id = MOCK_INTENT_ID): PayView {
  const { intentId, baseAmountTiyin, payAmountTiyin, card, expiresAt } = mockIntent(
    status,
    now,
    id,
  );
  return {
    intentId,
    status,
    baseAmountTiyin,
    payAmountTiyin,
    card,
    expiresAt,
    ownerHint: maskOwnerHint('Aziz', 'test_user_1'),
    currency: 'UZS',
  };
}
