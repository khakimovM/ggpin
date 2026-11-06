import {
  LedgerItemSchema,
  OrderDetailSchema,
  OrderSchema,
  PayLinkUrlSchema,
  PayViewSchema,
  PaymentMethodsResponseSchema,
  QuoteResponseSchema,
  TopupIntentCreatedSchema,
  TopupIntentSchema,
  ValidateRecipientResponseSchema,
  WalletResponseSchema,
  readPayLocaleFromQuery,
  readPayTokenFromHash,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  MOCK_PAYMENT_METHODS,
  MOCK_PAY_TOKEN,
  mockIntentCreated,
  mockIntent,
  mockPayView,
} from '../mock/fixtures/payments';
import { MOCK_RECIPIENT, mockOrder, mockOrderDetail, mockQuote } from '../mock/fixtures/orders';
import { MOCK_WALLET, MOCK_WALLET_LOW, mockLedger } from '../mock/fixtures/wallet';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const SITE = 'http://localhost:3100';

describe('fixtures pass their shared schemas', () => {
  it.each([
    ['wallet', WalletResponseSchema, MOCK_WALLET],
    ['wallet (low balance)', WalletResponseSchema, MOCK_WALLET_LOW],
    ['payment methods', PaymentMethodsResponseSchema, MOCK_PAYMENT_METHODS],
    ['recipient', ValidateRecipientResponseSchema, MOCK_RECIPIENT],
    ['quote', QuoteResponseSchema, mockQuote(NOW)],
    ['order', OrderSchema, mockOrder('PAID', NOW)],
    ['order detail (delivered)', OrderDetailSchema, mockOrderDetail('DELIVERED', NOW)],
    ['order detail (failed)', OrderDetailSchema, mockOrderDetail('FAILED', NOW)],
    ['intent created', TopupIntentCreatedSchema, mockIntentCreated({ siteUrl: SITE, now: NOW })],
  ] as const)('%s', (_name, schema, value) => {
    expect(() => (schema as z.ZodType).parse(value)).not.toThrow();
  });

  it.each(['PENDING', 'PAID', 'CANCELLED', 'EXPIRED'] as const)(
    'intent and pay view in %s',
    (status) => {
      expect(() => TopupIntentSchema.parse(mockIntent(status, NOW))).not.toThrow();
      expect(() => PayViewSchema.parse(mockPayView(status, NOW))).not.toThrow();
    },
  );

  it('every ledger row', () => {
    for (const entry of mockLedger(NOW)) expect(() => LedgerItemSchema.parse(entry)).not.toThrow();
  });
});

describe('the mock pay link (D-39)', () => {
  it.each(['uz', 'ru'] as const)(
    'keeps the token in the fragment and only the language in the query (%s)',
    (locale) => {
      const { redirectUrl } = mockIntentCreated({ siteUrl: SITE, now: NOW, locale });
      expect(() => PayLinkUrlSchema.parse(redirectUrl)).not.toThrow();

      const url = new URL(redirectUrl);
      expect(url.pathname).toBe('/pay/intent_mock_1');
      expect(url.search).toBe(`?locale=${locale}`);
      expect(url.searchParams.has('t')).toBe(false);
      expect(readPayTokenFromHash(url.hash)).toBe(MOCK_PAY_TOKEN);
      expect(readPayLocaleFromQuery(url.search)).toBe(locale);
    },
  );

  it('works without a language (the page then shows Uzbek)', () => {
    const { redirectUrl } = mockIntentCreated({ siteUrl: SITE, now: NOW });
    expect(new URL(redirectUrl).search).toBe('');
    expect(() => PayLinkUrlSchema.parse(redirectUrl)).not.toThrow();
  });
});
