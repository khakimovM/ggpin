// The admin read endpoints of phase 9 S4 (docs/04 "Admin"), one function each. Every response is
// checked against its shared schema in http.ts; the `group` names the mock group that may stand
// in for the endpoint on the dev server.
import {
  AdminAccountListResponseSchema,
  AdminBankMessageResponseSchema,
  AdminCardListResponseSchema,
  AdminCategoryListResponseSchema,
  AdminDashboardResponseSchema,
  AdminFxRateSchema,
  AdminInfraQueuesResponseSchema,
  AdminIntentRowSchema,
  AdminPaymentRowSchema,
  AdminPricePreviewResponseSchema,
  AdminProductDetailResponseSchema,
  AdminProductListResponseSchema,
  AdminReconcileDaySchema,
  AdminReviewDetailResponseSchema,
  AdminReviewRowSchema,
  AdminSessionListResponseSchema,
  AdminSettingsResponseSchema,
  type AdminDashboardResponse,
} from '@repo/shared';
import { apiFetch, apiFetchList } from './client';

export type Query = Readonly<Record<string, string | number | undefined>>;

export function getDashboard(
  period: string,
  signal?: AbortSignal,
): Promise<AdminDashboardResponse> {
  return apiFetch(
    { path: '/admin/dashboard', query: { period }, group: 'dashboard', signal },
    AdminDashboardResponseSchema,
  );
}

export const listIntents = (query: Query, signal?: AbortSignal) =>
  apiFetchList(
    { path: '/admin/payments/intents', query, group: 'payments', signal },
    AdminIntentRowSchema,
  );

export const listPayments = (query: Query, signal?: AbortSignal) =>
  apiFetchList(
    { path: '/admin/payments', query, group: 'payments', signal },
    AdminPaymentRowSchema,
  );

export const listReviews = (query: Query, signal?: AbortSignal) =>
  apiFetchList(
    { path: '/admin/payments/reviews', query, group: 'payments', signal },
    AdminReviewRowSchema,
  );

export const getReview = (id: string, signal?: AbortSignal) =>
  apiFetch(
    { path: `/admin/payments/reviews/${encodeURIComponent(id)}`, group: 'payments', signal },
    AdminReviewDetailResponseSchema,
  );

export const getBankMessage = (id: string, signal?: AbortSignal) =>
  apiFetch(
    { path: `/admin/payments/bank-messages/${encodeURIComponent(id)}`, group: 'payments', signal },
    AdminBankMessageResponseSchema,
  );

export const listCards = (signal?: AbortSignal) =>
  apiFetch(
    { path: '/admin/payments/cards', group: 'payments', signal },
    AdminCardListResponseSchema,
  );

export const listReconcile = (query: Query, signal?: AbortSignal) =>
  apiFetchList(
    { path: '/admin/payments/reconcile', query, group: 'payments', signal },
    AdminReconcileDaySchema,
  );

export const listCategories = (signal?: AbortSignal) =>
  apiFetch(
    { path: '/admin/categories', group: 'catalog', signal },
    AdminCategoryListResponseSchema,
  );

export const listProducts = (signal?: AbortSignal) =>
  apiFetch({ path: '/admin/products', group: 'catalog', signal }, AdminProductListResponseSchema);

export const getProduct = (id: string, signal?: AbortSignal) =>
  apiFetch(
    { path: `/admin/products/${encodeURIComponent(id)}`, group: 'catalog', signal },
    AdminProductDetailResponseSchema,
  );

export const getPricePreview = (id: string, skuId: string, signal?: AbortSignal) =>
  apiFetch(
    {
      path: `/admin/products/${encodeURIComponent(id)}/price-preview`,
      query: { skuId },
      group: 'catalog',
      signal,
    },
    AdminPricePreviewResponseSchema,
  );

export const getSettings = (signal?: AbortSignal) =>
  apiFetch({ path: '/admin/settings', group: 'settings', signal }, AdminSettingsResponseSchema);

export const listFxHistory = (query: Query, signal?: AbortSignal) =>
  apiFetchList({ path: '/admin/fx/history', query, group: 'settings', signal }, AdminFxRateSchema);

export const listQueues = (signal?: AbortSignal) =>
  apiFetch(
    { path: '/admin/infra/queues', group: 'queues', signal },
    AdminInfraQueuesResponseSchema,
  );

export const listAdmins = (signal?: AbortSignal) =>
  apiFetch({ path: '/admin/admins', group: 'admins', signal }, AdminAccountListResponseSchema);

export const listAdminSessions = (id: string, signal?: AbortSignal) =>
  apiFetch(
    { path: `/admin/admins/${encodeURIComponent(id)}/sessions`, group: 'admins', signal },
    AdminSessionListResponseSchema,
  );
