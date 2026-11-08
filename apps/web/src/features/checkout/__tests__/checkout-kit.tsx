import type { CatalogProductDetail, Me, OrderDto, QuoteResponse } from '@repo/shared';
import { screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { ApiError, type ApiErrorCode } from '../../../lib/api/errors';
import { qk } from '../../../lib/query-keys';
import { renderApp, testQueryClient } from '../../auth/__tests__/test-utils';
import type { QuoteControls, QuoteView } from '../../product/use-quote';
import { CheckoutFlow } from '../CheckoutFlow';

// Shared fixtures of the CheckoutFlow tests (the vi.mock calls stay in each test file).

export const PRODUCT = {
  id: 'p1',
  slug: 'telegram-stars',
  name: 'Telegram Stars',
} as unknown as CatalogProductDetail;

export const quote = (id: string, total: string): QuoteResponse => ({
  quoteId: id,
  priceTiyin: total,
  discountTiyin: '0',
  totalTiyin: total,
  expiresAt: '2030-01-01T00:00:00.000Z',
  recipient: { username: 'dilnoza_k', displayName: 'Dilnoza K.' },
  currency: 'UZS',
});
export const ready = (id: string, total: string): QuoteView => ({
  status: 'ready',
  quote: quote(id, total),
  msLeft: 540_000,
  expired: false,
});
export const controls = (view: QuoteView): QuoteControls => ({
  view,
  refresh: vi.fn(),
  discard: vi.fn(),
});

export const ORDER: OrderDto = {
  id: 'order_1',
  number: 1042,
  status: 'PAID',
  productId: 'p1',
  productSlug: 'telegram-stars',
  productName: 'Telegram Stars',
  skuId: null,
  quantity: 50,
  recipient: { displayName: 'Dilnoza K.', fields: { username: 'dilnoza_k' } },
  priceTiyin: '550000',
  discountTiyin: '0',
  totalTiyin: '550000',
  currency: 'UZS',
  createdAt: '2026-11-08T10:00:00.000Z',
  deliveredAt: null,
};

export function flow(
  quoteControls: QuoteControls,
  onOpenChange = vi.fn(),
  variant: 'tg' | 'web' = 'web',
) {
  return (
    <CheckoutFlow
      variant={variant}
      open
      onOpenChange={onOpenChange}
      product={PRODUCT}
      item="Telegram Stars · 50 ⭐"
      recipient={{ username: 'dilnoza_k', displayName: 'Dilnoza K.' }}
      quote={quoteControls}
    />
  );
}

export const payButton = () => screen.getByRole('button', { name: /^To‘lash · / });

export const USER_ID = 'user_1';
export const ME: Me = {
  id: USER_ID,
  telegramId: '1000001',
  username: 'aziz_k',
  firstName: 'Aziz',
  photoUrl: null,
  locale: 'uz',
  referralCode: 'AZIZ1',
  phoneLinked: true,
};

/** `renderApp` with the signed-in user already known (the product page has loaded it by now). */
export function renderCheckout(ui: ReactElement) {
  const client = testQueryClient();
  client.setQueryData(qk.me(), ME);
  return renderApp(ui, { client });
}

/** An error in the API's own envelope (`fromServer`), as the real client builds it. */
export const serverError = (init: {
  status: number;
  code: ApiErrorCode;
  details?: unknown;
  retryAfterSec?: number;
}) => new ApiError({ ...init, fromServer: true });
