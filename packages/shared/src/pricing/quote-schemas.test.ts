import { describe, expect, it } from 'vitest';
import {
  FX_MAX_AGE_MS,
  COST_MAX_AGE_MS,
  FX_MAX_JUMP_BPS,
  PRICE_SYNC_EVERY_MS,
  PRICE_SYNC_JOBS,
  QUOTE_TTL_MS,
  RECIPIENT_TOKEN_TTL_MS,
} from './pricing-constants';
import {
  CreateQuoteBodySchema,
  QuoteResponseSchema,
  RecipientSchema,
  RecipientTokenRecordSchema,
} from './quote-schemas';

const TOKEN = 'A'.repeat(43);
const base = { productId: 'prod_1', recipientToken: TOKEN };

describe('CreateQuoteBodySchema', () => {
  it('accepts exactly one of skuId or quantity', () => {
    expect(CreateQuoteBodySchema.safeParse({ ...base, skuId: 'sku_1' }).success).toBe(true);
    expect(CreateQuoteBodySchema.safeParse({ ...base, quantity: 75 }).success).toBe(true);
  });

  it('rejects both and neither', () => {
    expect(CreateQuoteBodySchema.safeParse({ ...base, skuId: 'sku_1', quantity: 75 }).success).toBe(
      false,
    );
    expect(CreateQuoteBodySchema.safeParse(base).success).toBe(false);
  });

  it('is strict: unknown keys (including a smuggled userId or price) are rejected', () => {
    for (const extra of [{ userId: 'u2' }, { priceTiyin: '1' }, { costMinor: '1' }]) {
      expect(CreateQuoteBodySchema.safeParse({ ...base, skuId: 'sku_1', ...extra }).success).toBe(
        false,
      );
    }
  });

  it('quantity must be a positive 32-bit integer', () => {
    for (const quantity of [0, -5, 1.5, 2_147_483_648, '50', null]) {
      expect(CreateQuoteBodySchema.safeParse({ ...base, quantity }).success, String(quantity)).toBe(
        false,
      );
    }
  });

  it('recipientToken must be 43 base64url chars', () => {
    for (const recipientToken of [
      '',
      'short',
      `${'A'.repeat(42)}=`,
      'A'.repeat(44),
      `${'A'.repeat(42)}!`,
    ]) {
      expect(
        CreateQuoteBodySchema.safeParse({ ...base, skuId: 's', recipientToken }).success,
        recipientToken,
      ).toBe(false);
    }
    expect(
      CreateQuoteBodySchema.safeParse({
        ...base,
        skuId: 's',
        recipientToken: `${'a-_'.repeat(14)}Z`,
      }).success,
    ).toBe(true);
  });

  it('discountCode is optional, trimmed, non-empty and bounded', () => {
    expect(
      CreateQuoteBodySchema.parse({ ...base, skuId: 's', discountCode: ' SAVE10 ' }).discountCode,
    ).toBe('SAVE10');
    expect(
      CreateQuoteBodySchema.safeParse({ ...base, skuId: 's', discountCode: '  ' }).success,
    ).toBe(false);
    expect(
      CreateQuoteBodySchema.safeParse({ ...base, skuId: 's', discountCode: 'x'.repeat(65) })
        .success,
    ).toBe(false);
  });

  it('ids are bounded strings', () => {
    expect(CreateQuoteBodySchema.safeParse({ ...base, productId: '', skuId: 's' }).success).toBe(
      false,
    );
    expect(
      CreateQuoteBodySchema.safeParse({ ...base, productId: 'p'.repeat(65), skuId: 's' }).success,
    ).toBe(false);
    expect(CreateQuoteBodySchema.safeParse({ ...base, skuId: 5 }).success).toBe(false);
  });
});

describe('QuoteResponseSchema', () => {
  const quote = {
    quoteId: 'q_1',
    priceTiyin: '2200000',
    discountTiyin: '0',
    totalTiyin: '2200000',
    expiresAt: '2026-11-01T10:10:00Z',
    recipient: { username: 'aziz_k', displayName: 'Aziz' },
    currency: 'UZS',
  };

  it('parses the docs/04 sample plus currency', () => {
    expect(QuoteResponseSchema.parse(quote)).toEqual(quote);
  });

  it('money must be strings and the currency UZS', () => {
    expect(QuoteResponseSchema.safeParse({ ...quote, priceTiyin: 2200000 }).success).toBe(false);
    expect(QuoteResponseSchema.safeParse({ ...quote, currency: 'USD' }).success).toBe(false);
    expect(QuoteResponseSchema.safeParse({ ...quote, expiresAt: 'tomorrow' }).success).toBe(false);
  });

  it('never exposes cost fields: they are stripped from a parsed response', () => {
    const parsed = QuoteResponseSchema.parse({
      ...quote,
      costMinor: '1',
      maxCostMinor: '2',
      costSnapshotId: 'c',
      fxRateId: 'f',
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'currency',
      'discountTiyin',
      'expiresAt',
      'priceTiyin',
      'quoteId',
      'recipient',
      'totalTiyin',
    ]);
  });
});

describe('RecipientSchema', () => {
  it('requires a Telegram-shaped username and a display name; photoUrl is optional https', () => {
    expect(RecipientSchema.safeParse({ username: 'aziz_k', displayName: 'Aziz' }).success).toBe(
      true,
    );
    expect(
      RecipientSchema.safeParse({
        username: 'aziz_k',
        displayName: 'Aziz',
        photoUrl: 'https://t.me/i/u.jpg',
      }).success,
    ).toBe(true);
    for (const username of ['abcd', '1abcde', '@aziz_k', 'a'.repeat(33), 'az iz_k', '']) {
      expect(RecipientSchema.safeParse({ username, displayName: 'A' }).success, username).toBe(
        false,
      );
    }
    expect(RecipientSchema.safeParse({ username: 'aziz_k', displayName: '   ' }).success).toBe(
      false,
    );
    expect(
      RecipientSchema.safeParse({
        username: 'aziz_k',
        displayName: 'A',
        photoUrl: 'javascript:alert(1)',
      }).success,
    ).toBe(false);
    expect(
      RecipientSchema.safeParse({ username: 'aziz_k', displayName: 'A', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('RecipientTokenRecordSchema', () => {
  const record = {
    userId: 'u1',
    productId: 'p1',
    recipient: { username: 'aziz_k', displayName: 'Aziz' },
    issuedAt: '2026-11-03T10:00:00.000Z',
  };

  it('round-trips through JSON (what Redis stores)', () => {
    expect(RecipientTokenRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('is strict and requires every field', () => {
    expect(RecipientTokenRecordSchema.safeParse({ ...record, extra: 1 }).success).toBe(false);
    const { userId: _userId, ...withoutUser } = record;
    expect(RecipientTokenRecordSchema.safeParse(withoutUser).success).toBe(false);
  });
});

describe('pricing constants', () => {
  it('match the approved plan and keep a sane ordering', () => {
    expect(QUOTE_TTL_MS).toBe(600_000);
    expect(RECIPIENT_TOKEN_TTL_MS).toBe(600_000);
    expect(FX_MAX_AGE_MS).toBe(1_800_000);
    expect(COST_MAX_AGE_MS).toBe(1_800_000);
    expect(PRICE_SYNC_EVERY_MS).toBe(300_000);
    expect(FX_MAX_JUMP_BPS).toBe(1000);
    expect(PRICE_SYNC_JOBS).toEqual({ FX: 'fx', COST: 'cost' });
    // several sync misses must fit inside the staleness window, or one hiccup stops all sales
    expect(PRICE_SYNC_EVERY_MS * 2).toBeLessThan(FX_MAX_AGE_MS);
    expect(PRICE_SYNC_EVERY_MS * 2).toBeLessThan(COST_MAX_AGE_MS);
  });
});
