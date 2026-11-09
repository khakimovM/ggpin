import type {
  OrderDetail,
  OrderDto,
  OrderStatus,
  QuoteResponse,
  ValidateRecipientResponse,
} from '@repo/shared';

// Dev mock data for `recipients`, `quotes` and `orders`. The recipient and order shapes are
// phase 5 DRAFTS in @repo/shared; the fixtures test keeps these honest against the current draft.

export const MOCK_ORDER_ID = 'order_mock_1';
const PRICE_TIYIN = '8540000'; // 85 400 so‘m

export const MOCK_RECIPIENT: ValidateRecipientResponse = {
  recipientToken: 'mockrecipienttoken'.padEnd(43, 'x'),
  displayName: 'Aziz',
  warnings: [],
};

export function mockQuote(now: Date): QuoteResponse {
  return {
    quoteId: 'quote_mock_1',
    priceTiyin: PRICE_TIYIN,
    discountTiyin: '0',
    totalTiyin: PRICE_TIYIN,
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    recipient: { username: 'test_user_1', displayName: 'Aziz' },
    currency: 'UZS',
  };
}

export function mockOrder(status: OrderStatus, now: Date, id = MOCK_ORDER_ID): OrderDto {
  return {
    id,
    number: 1024,
    status,
    productId: 'prod_stars',
    productSlug: 'telegram-stars',
    productName: 'Telegram Stars',
    skuId: 'sku_stars_100',
    quantity: 100,
    recipient: { displayName: 'Aziz', fields: { username: 'test_user_1' } },
    priceTiyin: PRICE_TIYIN,
    discountTiyin: '0',
    totalTiyin: PRICE_TIYIN,
    currency: 'UZS',
    createdAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
    deliveredAt: status === 'DELIVERED' ? now.toISOString() : null,
  };
}

const LIST_STATUSES: OrderStatus[] = [
  'PROCESSING',
  'DELIVERED',
  'NEEDS_REVIEW',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
  'DELIVERED',
];
const LIST_PRODUCTS = [
  { slug: 'telegram-stars', name: 'Telegram Stars', quantity: 500 },
  { slug: 'telegram-premium', name: 'Telegram Premium', quantity: 6 },
  { slug: 'pubg-mobile', name: 'PUBG Mobile', quantity: 660 },
] as const;

/** 25 orders, newest first, in every status group: enough for two pages of the history. */
export function mockOrderList(now: Date): OrderDto[] {
  return Array.from({ length: 25 }, (_, index) => {
    const status = LIST_STATUSES[index % LIST_STATUSES.length] ?? 'DELIVERED';
    const product = LIST_PRODUCTS[index % LIST_PRODUCTS.length] ?? LIST_PRODUCTS[0];
    const base = mockOrder(status, now, `order_mock_${index + 1}`);
    return {
      ...base,
      number: 1100 - index,
      productSlug: product.slug,
      productName: product.name,
      quantity: product.quantity,
      createdAt: new Date(now.getTime() - (index * 7 + 2) * 3_600_000).toISOString(),
    };
  });
}

export function mockOrderDetail(status: OrderStatus, now: Date, id = MOCK_ORDER_ID): OrderDetail {
  const at = (minutesAgo: number): string =>
    new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  return {
    ...mockOrder(status, now, id),
    timeline:
      status === 'PAID'
        ? [{ status: 'PAID', at: at(2) }]
        : [
            { status: 'PAID', at: at(2) },
            { status, at: at(1) },
          ],
    voucher: null,
  };
}
