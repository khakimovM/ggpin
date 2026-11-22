import {
  AdminAccountListResponseSchema,
  AdminAuditRowSchema,
  AdminBankMessageResponseSchema,
  AdminCardListResponseSchema,
  AdminCategoryListResponseSchema,
  AdminDashboardResponseSchema,
  AdminFxRateSchema,
  AdminInfraFragmentResponseSchema,
  AdminInfraQueuesResponseSchema,
  AdminInfraWalletResponseSchema,
  AdminIntentRowSchema,
  AdminOrderDetailResponseSchema,
  AdminOrderRowSchema,
  AdminPaymentRowSchema,
  AdminPricePreviewResponseSchema,
  AdminProductDetailResponseSchema,
  AdminProductListResponseSchema,
  AdminReconcileDaySchema,
  AdminReviewDetailResponseSchema,
  AdminReviewQueueResponseSchema,
  AdminReviewRowSchema,
  AdminSessionListResponseSchema,
  AdminSettingsResponseSchema,
  AdminUserDetailResponseSchema,
  AdminUserLedgerResponseSchema,
  AdminUserReferralsResponseSchema,
  AdminUserRowSchema,
  AdminUserSessionsResponseSchema,
} from '@repo/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAdminHttp } from '../../http';
import { MOCK_STATE_KEY, writeMockState } from '../mock-state';
import { readRoutes } from '../read-handlers';
import { createMockTransport } from '../transport';

const BASE = 'http://localhost:5000/api/v1';
const transport = createMockTransport({ apiBaseUrl: BASE });
const http = createAdminHttp({
  baseUrl: BASE,
  transportFor: () => Promise.resolve(transport),
  onSessionLost: () => undefined,
});

async function status(path: string): Promise<number> {
  const response = await transport({ method: 'GET', url: `${BASE}${path}`, headers: {} });
  return response.status;
}

beforeEach(() => {
  window.sessionStorage.removeItem(MOCK_STATE_KEY);
  writeMockState({ signedIn: true, role: 'OWNER', scenario: 'data' });
});

describe('mock read routes', () => {
  it('every read route has a permission (so the 404 matrix applies)', () => {
    for (const route of readRoutes) expect(route.permission, route.pattern).toBeDefined();
  });

  it('answers OWNER with schema-valid data', async () => {
    const dashboard = await http.fetch(
      { path: '/admin/dashboard', query: { period: 'week' } },
      AdminDashboardResponseSchema,
    );
    expect(dashboard.charts.revenue).toHaveLength(7);
    const users = await http.fetchList(
      { path: '/admin/users', query: { limit: 5 } },
      AdminUserRowSchema,
    );
    expect(users.items).toHaveLength(5);
    expect(users.meta.total).toBe(10);
  });

  it('answers every screen read with a body its shared schema accepts (R-16)', async () => {
    // [path, query, schema, list]: a list read is checked item by item plus its meta, like the
    // app's fetchList; every other read as one body. A fixture that drifts from the contract fails
    // here, not only on a screen.
    const reads: readonly [string, Record<string, string>, z.ZodType, boolean][] = [
      ['/admin/dashboard', { period: 'month' }, AdminDashboardResponseSchema, false],
      ['/admin/users/mkuser000001', {}, AdminUserDetailResponseSchema, false],
      ['/admin/users/mkuser000001/orders', {}, AdminOrderRowSchema, true],
      ['/admin/users/mkuser000001/ledger', {}, AdminUserLedgerResponseSchema.element, true],
      ['/admin/users/mkuser000001/payments', {}, AdminPaymentRowSchema, true],
      ['/admin/users/mkuser000001/referrals', {}, AdminUserReferralsResponseSchema.element, true],
      ['/admin/users/mkuser000001/sessions', {}, AdminUserSessionsResponseSchema.element, true],
      ['/admin/payments/intents', {}, AdminIntentRowSchema, true],
      ['/admin/payments', { status: 'CONFIRMED' }, AdminPaymentRowSchema, true],
      ['/admin/payments/reviews', {}, AdminReviewRowSchema, true],
      ['/admin/payments/reviews/mkrev000001', {}, AdminReviewDetailResponseSchema, false],
      ['/admin/payments/bank-messages/mkmsg000008', {}, AdminBankMessageResponseSchema, false],
      ['/admin/payments/cards', {}, AdminCardListResponseSchema, false],
      ['/admin/payments/reconcile', {}, AdminReconcileDaySchema, true],
      ['/admin/categories', {}, AdminCategoryListResponseSchema, false],
      ['/admin/products', {}, AdminProductListResponseSchema, false],
      ['/admin/products/mkprod000001', {}, AdminProductDetailResponseSchema, false],
      [
        '/admin/products/mkprod000001/price-preview',
        { skuId: 'mksku000006' },
        AdminPricePreviewResponseSchema,
        false,
      ],
      ['/admin/settings', {}, AdminSettingsResponseSchema, false],
      ['/admin/fx/history', { pair: 'TON_USDT' }, AdminFxRateSchema, true],
      ['/admin/orders', {}, AdminOrderRowSchema, true],
      ['/admin/orders/review-queue', {}, AdminReviewQueueResponseSchema.element, true],
      ['/admin/orders/mkord000001', {}, AdminOrderDetailResponseSchema, false],
      ['/admin/orders/mkord000006', {}, AdminOrderDetailResponseSchema, false],
      ['/admin/infra/queues', {}, AdminInfraQueuesResponseSchema, false],
      ['/admin/infra/wallet', {}, AdminInfraWalletResponseSchema, false],
      ['/admin/infra/fragment', {}, AdminInfraFragmentResponseSchema, false],
      ['/admin/audit-log', { actorType: 'ADMIN' }, AdminAuditRowSchema, true],
      ['/admin/admins', {}, AdminAccountListResponseSchema, false],
      ['/admin/admins/mkadm000001/sessions', {}, AdminSessionListResponseSchema, false],
    ];
    for (const [path, query, schema, list] of reads) {
      const request = { path, query };
      if (list) {
        const page = await http.fetchList(request, schema);
        expect(page.items.length, path).toBeGreaterThan(0);
      } else {
        await expect(http.fetch(request, schema), path).resolves.toBeDefined();
      }
    }
  });

  it('is the API 404 without a session and for a role without the right', async () => {
    writeMockState({ signedIn: false });
    expect(await status('/admin/users')).toBe(404);
    writeMockState({ signedIn: true, role: 'SUPPORT' });
    expect(await status('/admin/admins')).toBe(404);
    expect(await status('/admin/dashboard')).toBe(404);
    expect(await status('/admin/users')).toBe(200);
    writeMockState({ role: 'OPERATOR' });
    expect(await status('/admin/audit-log/export.csv')).toBe(404);
  });

  it('honours the empty and error scenarios', async () => {
    writeMockState({ scenario: 'empty' });
    const admins = await http.fetch({ path: '/admin/admins' }, AdminAccountListResponseSchema);
    expect(admins).toEqual([]);
    writeMockState({ scenario: 'error' });
    expect(await status('/admin/admins')).toBe(500);
  });

  it('filters users by status and search like the API', async () => {
    const frozen = await http.fetchList(
      { path: '/admin/users', query: { status: 'FROZEN' } },
      AdminUserRowSchema,
    );
    expect(frozen.items.map((user) => user.username)).toEqual(['bek_99']);
    const found = await http.fetchList(
      { path: '/admin/users', query: { q: '@sardor' } },
      AdminUserRowSchema,
    );
    expect(found.items).toHaveLength(1);
  });

  it('serves the audit CSV to OWNER as text', async () => {
    const csv = await http.fetchText({ path: '/admin/audit-log/export.csv' });
    expect(csv.split('\n')[0]).toBe(
      'id,createdAt,actorType,actorId,actorName,action,targetType,targetId,reason,ip,before,after',
    );
    expect(z.string().parse(csv)).toContain('ORDER_REFUND');
  });
});
