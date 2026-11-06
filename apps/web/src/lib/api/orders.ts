import {
  CreateOrderResponseSchema,
  OrderDetailSchema,
  OrderSchema,
  type CreateOrderBody,
  type CreateOrderResponse,
  type Locale,
  type OrderDetail,
  type OrderDto,
  type OrderStatus,
  type PageMeta,
} from '@repo/shared';
import { apiFetch, apiFetchList } from './client';
import { resourceId } from './path';

// Phase 5 DRAFT schemas (docs/04 "Buyurtmalar"): the `orders` mock group stays on until final.

export interface OrderListParams {
  status?: readonly OrderStatus[];
  locale?: Locale;
  page?: number;
  limit?: number;
}

/**
 * `idempotencyKey` is generated once per checkout attempt (see idempotency.ts) and reused on a
 * retry, so a double tap or a network retry can never pay twice.
 */
export function createOrder(
  body: CreateOrderBody,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<CreateOrderResponse> {
  return apiFetch(
    { method: 'POST', path: '/orders', body, idempotencyKey, group: 'orders', signal },
    CreateOrderResponseSchema,
  );
}

export function listOrders(
  params: OrderListParams = {},
  signal?: AbortSignal,
): Promise<{ items: OrderDto[]; meta: PageMeta }> {
  const { status, locale, page, limit } = params;
  return apiFetchList(
    { path: '/orders', query: { status, locale, page, limit }, group: 'orders', signal },
    OrderSchema,
  );
}

export async function getOrder(
  id: string,
  locale?: Locale,
  signal?: AbortSignal,
): Promise<OrderDetail> {
  return apiFetch(
    { path: `/orders/${resourceId(id)}`, query: { locale }, group: 'orders', signal },
    OrderDetailSchema,
  );
}
