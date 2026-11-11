import {
  LedgerItemSchema,
  PayLinkUrlSchema,
  PayViewSchema,
  PaymentMethodsResponseSchema,
  TopupIntentCreatedSchema,
  TopupIntentSchema,
  WalletResponseSchema,
  readPayLocaleFromQuery,
  readPayTokenFromHash,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  INTENT_ID,
  LEDGER,
  METHODS,
  PAY_TOKEN,
  WALLET,
  intent,
  intentCreated,
  payView,
} from './payment-fixtures';

describe('the wallet and top-up test values pass their shared schemas', () => {
  it('wallet, ledger, methods and a created intent', () => {
    expect(() => WalletResponseSchema.parse(WALLET)).not.toThrow();
    expect(() => PaymentMethodsResponseSchema.parse(METHODS)).not.toThrow();
    expect(() => TopupIntentCreatedSchema.parse(intentCreated())).not.toThrow();
    for (const entry of LEDGER) expect(() => LedgerItemSchema.parse(entry)).not.toThrow();
  });

  it.each(['PENDING', 'PAID', 'CANCELLED', 'EXPIRED'] as const)(
    'intent and pay view in %s',
    (status) => {
      expect(() => TopupIntentSchema.parse(intent(status))).not.toThrow();
      expect(() => PayViewSchema.parse(payView(status))).not.toThrow();
    },
  );
});

describe('the pay link (D-39)', () => {
  it.each(['uz', 'ru'] as const)(
    'keeps the token in the fragment and only the language in the query (%s)',
    (locale) => {
      const { redirectUrl } = intentCreated(locale);
      expect(() => PayLinkUrlSchema.parse(redirectUrl)).not.toThrow();

      const url = new URL(redirectUrl);
      expect(url.pathname).toBe(`/pay/${INTENT_ID}`);
      expect(url.search).toBe(`?locale=${locale}`);
      expect(url.searchParams.has('t')).toBe(false);
      expect(readPayTokenFromHash(url.hash)).toBe(PAY_TOKEN);
      expect(readPayLocaleFromQuery(url.search)).toBe(locale);
    },
  );

  it('works without a language (the page then shows Uzbek)', () => {
    const { redirectUrl } = intentCreated();
    expect(new URL(redirectUrl).search).toBe('');
    expect(() => PayLinkUrlSchema.parse(redirectUrl)).not.toThrow();
  });
});
