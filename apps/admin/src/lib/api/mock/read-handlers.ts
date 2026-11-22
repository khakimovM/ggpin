// Read routes of the dev mock: the S4 admin read API (docs/04 "Admin") plus the orders, wallet
// and Fragment reads that arrive in phase 9-B. Each route names its read permission, so the
// transport answers 404 exactly where the AdminGuard would.
import { auditCsvRoute } from './audit-csv';
import { listOf, pageOf, since, whereParam } from './data-common';
import { dashboardFixture } from './fixtures-dashboard';
import {
  CARDS,
  INTENTS,
  PAYMENTS,
  RECONCILE,
  REVIEWS,
  bankMessageFixture,
} from './fixtures-payments';
import {
  CATEGORIES,
  FX_HISTORY,
  PRODUCTS,
  SETTINGS,
  pricePreviewFixture,
  productDetailFixture,
} from './fixtures-catalog';
import { ORDERS, REVIEW_QUEUE, orderDetailFixture } from './fixtures-orders';
import { ADMINS, AUDIT, FRAGMENT, QUEUE_ROWS, WALLET, adminSessionsFixture } from './fixtures-ops';
import {
  USERS,
  USER_LEDGER,
  USER_REFERRALS,
  USER_SESSIONS,
  userDetailFixture,
} from './fixtures-users';
import { readMockState } from './mock-state';
import { fail, ok, type MockRoute } from './router';

const get = (
  pattern: string,
  permission: MockRoute['permission'],
  handler: MockRoute['handler'],
): MockRoute => ({ method: 'GET', pattern, permission, handler });

const empty = () => readMockState().scenario === 'empty';

function userStatus(user: (typeof USERS)[number]): string {
  if (user.isBlocked) return 'BLOCKED';
  if (user.purchaseFrozen) return 'FROZEN';
  if (user.botBlocked) return 'BOT_BLOCKED';
  return 'ACTIVE';
}

const userRoutes: MockRoute[] = [
  get('/admin/users', 'users.read', ({ query }) => {
    const q = query.get('q')?.toLowerCase().replace(/^@/, '');
    const rows = whereParam(USERS, query, 'status', userStatus).filter(
      (user) =>
        !q || user.telegramId.includes(q) || (user.username ?? '').toLowerCase().includes(q),
    );
    return pageOf(
      since(rows, query, (user) => user.createdAt),
      query,
    );
  }),
  get('/admin/users/:id', 'users.read', ({ params }) => {
    const user = USERS.find((one) => one.id === params.id);
    return user ? ok(userDetailFixture(user, readMockState().role)) : fail('NOT_FOUND');
  }),
  get('/admin/users/:id/orders', 'users.read', ({ params, query }) =>
    pageOf(
      ORDERS.filter((order) => order.user.id === params.id || params.id === USERS[0]?.id),
      query,
    ),
  ),
  get('/admin/users/:id/ledger', 'users.read', ({ query }) => pageOf(USER_LEDGER, query)),
  get('/admin/users/:id/payments', 'users.read', ({ query }) => pageOf(PAYMENTS, query)),
  get('/admin/users/:id/referrals', 'users.read', ({ query }) => pageOf(USER_REFERRALS, query)),
  get('/admin/users/:id/sessions', 'users.read', ({ query }) => pageOf(USER_SESSIONS, query)),
];

const paymentRoutes: MockRoute[] = [
  get('/admin/payments/intents', 'payments.read', ({ query }) =>
    pageOf(
      since(
        whereParam(
          whereParam(INTENTS, query, 'status', (row) => row.status),
          query,
          'cardId',
          (row) => row.card?.id ?? null,
        ),
        query,
        (row) => row.createdAt,
      ),
      query,
    ),
  ),
  get('/admin/payments/reviews', 'payments.read', ({ query }) => {
    const status = query.get('status') ?? 'OPEN';
    const rows = whereParam(
      REVIEWS.filter((row) => row.status === status),
      query,
      'kind',
      (row) => row.kind,
    );
    return pageOf(rows, query);
  }),
  get('/admin/payments/reviews/:id', 'payments.read', ({ params }) => {
    const review = REVIEWS.find((row) => row.id === params.id);
    if (review === undefined) return fail('NOT_FOUND');
    const role = readMockState().role;
    return ok({
      ...review,
      bankMessage: bankMessageFixture(review.bankMessageId, role),
      payment: null,
      note: null,
      resolvedAuditId: null,
    });
  }),
  get('/admin/payments/bank-messages/:id', 'payments.read', ({ params }) =>
    ok(bankMessageFixture(params.id ?? '', readMockState().role)),
  ),
  get('/admin/payments/cards', 'payments.read', () => listOf(CARDS)),
  get('/admin/payments/reconcile', 'payments.read', ({ query }) => pageOf(RECONCILE, query)),
  get('/admin/payments', 'payments.read', ({ query }) =>
    pageOf(
      since(
        whereParam(PAYMENTS, query, 'status', (row) => row.status),
        query,
        (row) => row.createdAt,
      ),
      query,
    ),
  ),
];

const catalogRoutes: MockRoute[] = [
  get('/admin/dashboard', 'dashboard.read', ({ query }) =>
    ok(dashboardFixture(query.get('period') ?? 'today', empty())),
  ),
  get('/admin/categories', 'catalog.read', () => listOf(CATEGORIES)),
  get('/admin/products', 'catalog.read', () => listOf(PRODUCTS)),
  get('/admin/products/:id', 'catalog.read', ({ params }) => {
    const product = productDetailFixture(params.id ?? '');
    return product ? ok(product) : fail('NOT_FOUND');
  }),
  get('/admin/products/:id/price-preview', 'catalog.read', ({ query }) =>
    ok(pricePreviewFixture(query.get('skuId') ?? '')),
  ),
  get('/admin/settings', 'settings.read', () => ok(empty() ? { items: [] } : SETTINGS)),
  get('/admin/fx/history', 'settings.read', ({ query }) =>
    pageOf(
      whereParam(FX_HISTORY, query, 'pair', (row) => row.pair),
      query,
    ),
  ),
];

const opsRoutes: MockRoute[] = [
  get('/admin/orders/review-queue', 'orders.read', ({ query }) =>
    pageOf(
      whereParam(REVIEW_QUEUE, query, 'status', (row) => row.status),
      query,
    ),
  ),
  get('/admin/orders/:id', 'orders.read', ({ params }) => {
    const order = orderDetailFixture(params.id ?? '');
    return order ? ok(order) : fail('NOT_FOUND');
  }),
  get('/admin/orders', 'orders.read', ({ query }) => {
    const statuses = query.get('status')?.split(',');
    const q = query.get('q')?.toLowerCase().replace(/^[@#]/, '');
    const rows = ORDERS.filter(
      (order) =>
        (!statuses || statuses.includes(order.status)) &&
        (!q ||
          String(order.number).includes(q) ||
          (order.user.username ?? '').toLowerCase().includes(q)),
    );
    return pageOf(
      since(rows, query, (order) => order.createdAt),
      query,
    );
  }),
  get('/admin/infra/queues', 'infra.read', () => listOf(QUEUE_ROWS)),
  get('/admin/infra/wallet', 'infra.read', () =>
    ok(empty() ? { ...WALLET, balance: null, recentTransfers: [] } : WALLET),
  ),
  get('/admin/infra/fragment', 'infra.read', () =>
    ok(empty() ? { status: 'NONE', lastOkAt: null, deadAt: null, updatedAt: null } : FRAGMENT),
  ),
  get('/admin/audit-log', 'audit.read', ({ query }) => {
    const rows = whereParam(
      whereParam(
        whereParam(AUDIT, query, 'actorType', (row) => row.actor.type),
        query,
        'action',
        (row) => row.action,
      ),
      query,
      'targetType',
      (row) => row.targetType,
    );
    return pageOf(
      since(rows, query, (row) => row.createdAt),
      query,
    );
  }),
  auditCsvRoute(AUDIT),
  get('/admin/admins', 'admins.read', () => listOf(ADMINS)),
  get('/admin/admins/:id/sessions', 'admins.read', ({ params }) =>
    listOf(adminSessionsFixture(params.id ?? '')),
  ),
];

export const readRoutes: readonly MockRoute[] = [
  ...userRoutes,
  ...paymentRoutes,
  ...catalogRoutes,
  ...opsRoutes,
];
