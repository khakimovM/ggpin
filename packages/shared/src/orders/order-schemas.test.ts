import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_KEY_PATTERN, IdempotencyKeySchema } from '../common-schemas';
import {
  CreateOrderBodySchema,
  CreateOrderResponseSchema,
  InsufficientBalanceDetailsSchema,
  QuoteAlreadyUsedDetailsSchema,
  OrderDetailSchema,
  OrderDetailQuerySchema,
  OrderListQuerySchema,
  OrderParamsSchema,
  OrderSchema,
  ValidateRecipientBodySchema,
  ValidateRecipientResponseSchema,
} from './order-schemas';

const TOKEN = 'A'.repeat(43);

const order = {
  id: 'cm0order1',
  number: 1042,
  status: 'PAID',
  productId: 'cm0prod1',
  productSlug: 'telegram-stars',
  productName: 'Telegram Stars',
  skuId: 'cm0sku1',
  quantity: 50,
  recipient: { displayName: 'Aziz', fields: { username: 'aziz_k' } },
  priceTiyin: '550000',
  discountTiyin: '0',
  totalTiyin: '550000',
  currency: 'UZS',
  createdAt: '2026-11-04T10:00:00.000Z',
  deliveredAt: null,
};

describe('ValidateRecipientBodySchema', () => {
  it('accepts the documented body', () => {
    const body = { productId: 'cm0prod1', input: { username: 'aziz_k' } };
    expect(ValidateRecipientBodySchema.safeParse(body).success).toBe(true);
  });

  it('is strict, bounded and free of control characters', () => {
    const base = { productId: 'cm0prod1', input: { username: 'aziz_k' } };
    expect(ValidateRecipientBodySchema.safeParse({ ...base, userId: 'u' }).success).toBe(false);
    expect(
      ValidateRecipientBodySchema.safeParse({ ...base, input: { username: 'a\u0000b' } }).success,
    ).toBe(false);
    expect(
      ValidateRecipientBodySchema.safeParse({ ...base, input: { 'Bad Key': 'x' } }).success,
    ).toBe(false);
    expect(
      ValidateRecipientBodySchema.safeParse({ ...base, input: { username: '' } }).success,
    ).toBe(false);
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, 'x']));
    expect(ValidateRecipientBodySchema.safeParse({ ...base, input: nine }).success).toBe(false);
  });
});

describe('ValidateRecipientResponseSchema', () => {
  const response = { recipientToken: TOKEN, displayName: 'Aziz', warnings: [] };

  it('accepts a response without warnings, with a photo, and with a non-blocking warning', () => {
    expect(ValidateRecipientResponseSchema.safeParse(response).success).toBe(true);
    expect(
      ValidateRecipientResponseSchema.safeParse({
        ...response,
        photoUrl: 'https://cdn.example/a.jpg',
      }).success,
    ).toBe(true);
    expect(
      ValidateRecipientResponseSchema.safeParse({
        ...response,
        warnings: [{ code: 'LOW_STOCK', message: 'warnings.LOW_STOCK' }],
      }).success,
    ).toBe(true);
  });

  it('rejects a short token, a missing warnings array and a malformed warning', () => {
    expect(
      ValidateRecipientResponseSchema.safeParse({ ...response, recipientToken: 'short' }).success,
    ).toBe(false);
    expect(
      ValidateRecipientResponseSchema.safeParse({ recipientToken: TOKEN, displayName: 'Aziz' })
        .success,
    ).toBe(false);
    expect(
      ValidateRecipientResponseSchema.safeParse({
        ...response,
        warnings: [{ code: 'other', message: 'errors.X' }],
      }).success,
    ).toBe(false);
  });
});

describe('orders', () => {
  it('CreateOrderBodySchema takes only a quote id', () => {
    expect(CreateOrderBodySchema.safeParse({ quoteId: 'cm0quote1' }).success).toBe(true);
    expect(CreateOrderBodySchema.safeParse({ quoteId: 'cm0quote1', userId: 'u' }).success).toBe(
      false,
    );
    expect(CreateOrderBodySchema.safeParse({}).success).toBe(false);
  });

  it('OrderSchema: money as strings, raw status, nothing internal', () => {
    expect(OrderSchema.safeParse(order).success).toBe(true);
    expect(OrderSchema.safeParse({ ...order, priceTiyin: 550000 }).success).toBe(false);
    expect(OrderSchema.safeParse({ ...order, status: 'QUOTED' }).success).toBe(false);
    for (const leak of [{ costMinor: '1' }, { fxRateId: 'f' }, { statusReason: 'x' }]) {
      expect(OrderSchema.safeParse({ ...order, ...leak }).success).toBe(false);
    }
  });

  it('the recipient fits a game player id as well as a Telegram username', () => {
    const game = { displayName: 'Nick', fields: { playerId: '12345678', zone: '2001' } };
    expect(OrderSchema.safeParse({ ...order, recipient: game }).success).toBe(true);
    expect(OrderSchema.safeParse({ ...order, recipient: { displayName: 'Nick' } }).success).toBe(
      false,
    );
    expect(OrderSchema.safeParse({ ...order, recipient: { ...game, userId: 'u1' } }).success).toBe(
      false,
    );
  });

  it('CreateOrderResponseSchema wraps the order as { order }', () => {
    expect(CreateOrderResponseSchema.safeParse({ order }).success).toBe(true);
    expect(CreateOrderResponseSchema.safeParse(order).success).toBe(false);
  });

  it('OrderDetailSchema adds the timeline and the voucher', () => {
    const detail = {
      ...order,
      status: 'DELIVERED',
      deliveredAt: '2026-11-04T10:01:00.000Z',
      timeline: [
        { status: 'PAID', at: '2026-11-04T10:00:00.000Z' },
        { status: 'DELIVERED', at: '2026-11-04T10:01:00.000Z' },
      ],
      voucher: null,
    };
    expect(OrderDetailSchema.safeParse(detail).success).toBe(true);
    expect(OrderDetailSchema.safeParse({ ...detail, voucher: { code: 'ABCD-1234' } }).success).toBe(
      true,
    );
    expect(OrderDetailSchema.safeParse({ ...detail, timeline: [] }).success).toBe(false);
    expect(
      OrderDetailSchema.safeParse({
        ...detail,
        timeline: [{ status: 'PAID', at: detail.createdAt, actor: 'ADMIN:1' }],
      }).success,
    ).toBe(false);
  });

  it('OrderListQuerySchema and OrderParamsSchema', () => {
    expect(OrderListQuerySchema.parse({})).toEqual({ locale: 'uz', page: 1, limit: 20 });
    expect(OrderListQuerySchema.parse({ status: 'DELIVERED', limit: '100', locale: 'ru' })).toEqual(
      {
        status: ['DELIVERED'],
        locale: 'ru',
        page: 1,
        limit: 100,
      },
    );
    // Recommendation Q-C: several statuses, comma-separated.
    expect(OrderListQuerySchema.parse({ status: 'PAID,QUEUED' }).status).toEqual([
      'PAID',
      'QUEUED',
    ]);
    for (const bad of ['PAID,', ',PAID', 'PAID,NOPE', '']) {
      expect(OrderListQuerySchema.safeParse({ status: bad }).success, bad).toBe(false);
    }
    expect(OrderListQuerySchema.safeParse({ locale: 'en' }).success).toBe(false);
    expect(OrderDetailQuerySchema.parse({})).toEqual({ locale: 'uz' });
    expect(OrderDetailQuerySchema.safeParse({ page: '2' }).success).toBe(false);
    expect(OrderListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(OrderListQuerySchema.safeParse({ status: 'nope' }).success).toBe(false);
    expect(OrderParamsSchema.safeParse({ id: 'cm0order1' }).success).toBe(true);
    expect(OrderParamsSchema.safeParse({ id: 'a b' }).success).toBe(false);
  });
});

describe('IdempotencyKeySchema', () => {
  it('takes 8..128 characters of A-Z a-z 0-9 _ -', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('x')).toBe(false);
    for (const ok of ['12345678', '3f2b8c1e-9d4a-4b7e-a1c2-0123456789ab', 'a'.repeat(128)]) {
      expect(IdempotencyKeySchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['short', 'a'.repeat(129), 'has space1', 'new\nline1', 'ключ-ключ-ключ']) {
      expect(IdempotencyKeySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('POST /orders answers with details', () => {
  it('productSlug is a catalog slug, not any string', () => {
    expect(OrderSchema.safeParse({ ...order, productSlug: 'Telegram Stars' }).success).toBe(false);
    expect(OrderSchema.safeParse({ ...order, productSlug: '../x' }).success).toBe(false);
  });

  it('INSUFFICIENT_BALANCE details: three tiyin strings and nothing else', () => {
    const ok = { balance: '100', required: '550000', shortfall: '549900' };
    expect(InsufficientBalanceDetailsSchema.safeParse(ok).success).toBe(true);
    expect(InsufficientBalanceDetailsSchema.safeParse({ ...ok, balance: 100 }).success).toBe(false);
    expect(InsufficientBalanceDetailsSchema.safeParse({ ...ok, extra: '1' }).success).toBe(false);
    expect(InsufficientBalanceDetailsSchema.safeParse({ balance: '1' }).success).toBe(false);
  });

  it('INSUFFICIENT_BALANCE: the balance may be negative (D-60); required and shortfall are positive', () => {
    const owing = { balance: '-100000', required: '550000', shortfall: '650000' };
    expect(InsufficientBalanceDetailsSchema.safeParse(owing).success).toBe(true);
    for (const bad of [
      { ...owing, required: '-550000' },
      { ...owing, shortfall: '-1' },
      // Review N7: a 422 is sent only when something is missing, so both are above zero.
      { ...owing, required: '0' },
      { ...owing, shortfall: '0' },
      { ...owing, shortfall: '00' },
      { ...owing, balance: '-0' },
      { ...owing, balance: '-' },
    ]) {
      expect(InsufficientBalanceDetailsSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('QUOTE_ALREADY_USED details: only the order id', () => {
    expect(QuoteAlreadyUsedDetailsSchema.safeParse({ orderId: 'cm0order1' }).success).toBe(true);
    expect(QuoteAlreadyUsedDetailsSchema.safeParse({}).success).toBe(false);
    expect(
      QuoteAlreadyUsedDetailsSchema.safeParse({ orderId: 'cm0order1', userId: 'u' }).success,
    ).toBe(false);
  });
});
