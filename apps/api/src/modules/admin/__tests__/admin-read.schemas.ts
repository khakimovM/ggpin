import {
  AdminAccountListResponseSchema,
  AdminAuditListResponseSchema,
  AdminBankMessageResponseSchema,
  AdminCardListResponseSchema,
  AdminCategoryListResponseSchema,
  AdminCreditPreviewResponseSchema,
  AdminDashboardResponseSchema,
  AdminFxHistoryResponseSchema,
  AdminInfraQueuesResponseSchema,
  AdminIntentListResponseSchema,
  AdminOrderListResponseSchema,
  AdminPaymentListResponseSchema,
  AdminPricePreviewResponseSchema,
  AdminProductDetailResponseSchema,
  AdminProductListResponseSchema,
  AdminReconcileResponseSchema,
  AdminReviewDetailResponseSchema,
  AdminReviewListResponseSchema,
  AdminSessionListResponseSchema,
  AdminSettingsResponseSchema,
  AdminUserDetailResponseSchema,
  AdminUserLedgerResponseSchema,
  AdminUserListResponseSchema,
  AdminUserReferralsResponseSchema,
  AdminUserSessionsResponseSchema,
} from '@repo/shared';
import type { ZodType } from 'zod';

// SA-S4-4: every 200 of an admin read in the e2e suites goes through the shared response schema
// of its route, for whichever role asked. The shared schemas are `z.strictObject` throughout, so
// an extra key (a column a select picked up) fails the parse; the free-JSON fields (audit
// `before`/`after`, a bank message's raw text) are typed as JSON on purpose and are covered by
// the redaction tests and the body scan instead.
const ID = '[^/]+';
const PATHS: readonly (readonly [string, ZodType])[] = [
  ['dashboard', AdminDashboardResponseSchema],
  ['users', AdminUserListResponseSchema],
  [`users/${ID}`, AdminUserDetailResponseSchema],
  [`users/${ID}/orders`, AdminOrderListResponseSchema],
  [`users/${ID}/ledger`, AdminUserLedgerResponseSchema],
  [`users/${ID}/payments`, AdminPaymentListResponseSchema],
  [`users/${ID}/referrals`, AdminUserReferralsResponseSchema],
  [`users/${ID}/sessions`, AdminUserSessionsResponseSchema],
  ['payments', AdminPaymentListResponseSchema],
  ['payments/intents', AdminIntentListResponseSchema],
  ['payments/reviews', AdminReviewListResponseSchema],
  [`payments/reviews/${ID}`, AdminReviewDetailResponseSchema],
  [`payments/reviews/${ID}/credit-preview`, AdminCreditPreviewResponseSchema],
  [`payments/bank-messages/${ID}`, AdminBankMessageResponseSchema],
  ['payments/cards', AdminCardListResponseSchema],
  ['payments/reconcile', AdminReconcileResponseSchema],
  ['audit-log', AdminAuditListResponseSchema],
  ['admins', AdminAccountListResponseSchema],
  [`admins/${ID}/sessions`, AdminSessionListResponseSchema],
  ['categories', AdminCategoryListResponseSchema],
  ['products', AdminProductListResponseSchema],
  [`products/${ID}`, AdminProductDetailResponseSchema],
  [`products/${ID}/price-preview`, AdminPricePreviewResponseSchema],
  ['settings', AdminSettingsResponseSchema],
  ['fx/history', AdminFxHistoryResponseSchema],
  ['infra/queues', AdminInfraQueuesResponseSchema],
];
const ROUTES = PATHS.map(
  ([path, schema]) => [new RegExp(`^/api/v1/admin/${path}$`), schema] as const,
);

// Named sub-routes win over `:id` ones (`payments/intents` is not a review id).
function schemaFor(path: string): ZodType {
  const matches = ROUTES.filter(([pattern]) => pattern.test(path));
  const exact = matches.find(([pattern]) => !pattern.source.includes('[^/]+'));
  const found = exact ?? matches[0];
  if (found === undefined) throw new Error(`no response schema for ${path}`);
  return found[1];
}

/** Parses a 200 body's `data` with its route's schema (throws on a mismatch); other statuses pass. */
export function checkRead(url: string, status: number, body: unknown): void {
  if (status !== 200) return;
  const path = url.split('?')[0] ?? url;
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : body;
  schemaFor(path).parse(data);
}
