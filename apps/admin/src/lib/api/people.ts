// Users, orders and the audit log (docs/04 "Admin"). Orders, the review queue and the hot wallet /
// Fragment status have no API before phase 9-B: their groups are mocked on the dev server.
import {
  AdminAuditRowSchema,
  AdminInfraFragmentResponseSchema,
  AdminInfraWalletResponseSchema,
  AdminOrderDetailResponseSchema,
  AdminOrderRowSchema,
  AdminPaymentRowSchema,
  AdminUserDetailResponseSchema,
  AdminUserLedgerResponseSchema,
  AdminUserReferralsResponseSchema,
  AdminUserRowSchema,
  AdminUserSessionsResponseSchema,
  AdminReviewQueueResponseSchema,
} from '@repo/shared';
import { apiFetch, apiFetchList } from './client';
import type { Query } from './reads';

const id = (value: string) => encodeURIComponent(value);

export const listUsers = (query: Query, signal?: AbortSignal) =>
  apiFetchList({ path: '/admin/users', query, group: 'users', signal }, AdminUserRowSchema);

export const getUser = (userId: string, signal?: AbortSignal) =>
  apiFetch(
    { path: `/admin/users/${id(userId)}`, group: 'users', signal },
    AdminUserDetailResponseSchema,
  );

export const USER_TABS = ['orders', 'ledger', 'payments', 'referrals', 'sessions'] as const;
export type UserTab = (typeof USER_TABS)[number];

const TAB_ROW = {
  orders: AdminOrderRowSchema,
  ledger: AdminUserLedgerResponseSchema.element,
  payments: AdminPaymentRowSchema,
  referrals: AdminUserReferralsResponseSchema.element,
  sessions: AdminUserSessionsResponseSchema.element,
} as const;

export const listUserOrders = (userId: string, query: Query, signal?: AbortSignal) =>
  apiFetchList(
    { path: `/admin/users/${id(userId)}/orders`, query, group: 'users', signal },
    TAB_ROW.orders,
  );
export const listUserLedger = (userId: string, query: Query, signal?: AbortSignal) =>
  apiFetchList(
    { path: `/admin/users/${id(userId)}/ledger`, query, group: 'users', signal },
    TAB_ROW.ledger,
  );
export const listUserPayments = (userId: string, query: Query, signal?: AbortSignal) =>
  apiFetchList(
    { path: `/admin/users/${id(userId)}/payments`, query, group: 'users', signal },
    TAB_ROW.payments,
  );
export const listUserReferrals = (userId: string, query: Query, signal?: AbortSignal) =>
  apiFetchList(
    { path: `/admin/users/${id(userId)}/referrals`, query, group: 'users', signal },
    TAB_ROW.referrals,
  );
export const listUserSessions = (userId: string, query: Query, signal?: AbortSignal) =>
  apiFetchList(
    { path: `/admin/users/${id(userId)}/sessions`, query, group: 'users', signal },
    TAB_ROW.sessions,
  );

export const listAudit = (query: Query, signal?: AbortSignal) =>
  apiFetchList({ path: '/admin/audit-log', query, group: 'audit', signal }, AdminAuditRowSchema);

export const listOrders = (query: Query, signal?: AbortSignal) =>
  apiFetchList({ path: '/admin/orders', query, group: 'orders', signal }, AdminOrderRowSchema);

export const getOrder = (orderId: string, signal?: AbortSignal) =>
  apiFetch(
    { path: `/admin/orders/${id(orderId)}`, group: 'orders', signal },
    AdminOrderDetailResponseSchema,
  );

export const listReviewQueue = (query: Query, signal?: AbortSignal) =>
  apiFetchList(
    { path: '/admin/orders/review-queue', query, group: 'orders', signal },
    AdminReviewQueueResponseSchema.element,
  );

export const getWallet = (signal?: AbortSignal) =>
  apiFetch(
    { path: '/admin/infra/wallet', group: 'wallet', signal },
    AdminInfraWalletResponseSchema,
  );

export const getFragment = (signal?: AbortSignal) =>
  apiFetch(
    { path: '/admin/infra/fragment', group: 'fragment', signal },
    AdminInfraFragmentResponseSchema,
  );
