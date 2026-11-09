import type { BrowserContext, Page, Route } from '@playwright/test';

// A fake of `GET /orders` (the list), `GET /me/ledger` and `PATCH /me`, shaped like docs/04. It
// filters and pages the way the server will (`status` is a comma-separated list of raw statuses,
// `page` / `limit`, newest first), so a test can see which request each chip and each page button
// sent. Layered on top of the other fakes: everything else (`/me`, the wallet, one order) falls
// through to them.

const ORDER_LIST = /^http:\/\/localhost:5000\/api\/v1\/orders(\?.*)?$/;
const LEDGER = /^http:\/\/localhost:5000\/api\/v1\/me\/ledger(\?.*)?$/;
const ME = /^http:\/\/localhost:5000\/api\/v1\/me$/;

export type ListMode = 'ok' | 'empty' | 'error' | 'slow';

export interface AccountApiOptions {
  orders?: ListMode;
  ledger?: ListMode;
  /** Number of orders the server holds (default 25: two pages). */
  orderCount?: number;
  /** `PATCH /me` answers an error. */
  patchFails?: boolean;
}

export interface AccountApi {
  /** The URL of every `GET /orders` the page sent. */
  orderRequests: URL[];
  ledgerRequests: URL[];
  /** The body of every `PATCH /me`. */
  patches: unknown[];
  setOrders: (mode: ListMode) => void;
  setLedger: (mode: ListMode) => void;
  /** Lets a `slow` list answer. */
  release: () => void;
}

const STATUSES = ['PROCESSING', 'DELIVERED', 'NEEDS_REVIEW', 'DELIVERED', 'FAILED', 'CANCELLED'];
const PRODUCTS = [
  { slug: 'telegram-stars', name: 'Telegram Stars', quantity: 500, total: '11000000' },
  { slug: 'telegram-premium', name: 'Telegram Premium', quantity: 6, total: '22000000' },
  { slug: 'pubg-mobile', name: 'PUBG Mobile', quantity: 660, total: '12075000' },
];
const HOUR = 3_600_000;

export function fakeOrder(index: number, now = Date.now()) {
  const product = PRODUCTS[index % PRODUCTS.length] ?? PRODUCTS[0];
  const status = STATUSES[index % STATUSES.length] ?? 'DELIVERED';
  return {
    id: `order_${index + 1}`,
    number: 10500 - index,
    status,
    productId: `prod_${product?.slug}`,
    productSlug: product?.slug,
    productName: product?.name,
    skuId: null,
    quantity: product?.quantity,
    recipient: { displayName: 'Dilnoza K.', fields: { username: 'dilnoza_k' } },
    priceTiyin: product?.total,
    discountTiyin: '0',
    totalTiyin: product?.total,
    currency: 'UZS',
    createdAt: new Date(now - (index * 7 + 1) * HOUR).toISOString(),
    deliveredAt: null,
  };
}

const LEDGER_KINDS: Array<[string, string, string | null, string | null]> = [
  ['PURCHASE', '-11000000', 'order_1', null],
  ['TOPUP', '5034700', null, 'payment_1'],
  ['REFUND', '12075000', 'order_5', null],
  ['REFERRAL_BONUS', '110000', null, null],
  ['PURCHASE', '-12075000', 'order_5', null],
];

export function fakeLedger(index: number, now = Date.now()) {
  const [kind, amountTiyin, orderId, paymentId] = LEDGER_KINDS[index % LEDGER_KINDS.length] ?? [
    'PURCHASE',
    '-100',
    null,
    null,
  ];
  return {
    id: `ledger_${index + 1}`,
    kind,
    amountTiyin,
    createdAt: new Date(now - (index * 5 + 1) * HOUR).toISOString(),
    orderId,
    paymentId,
  };
}

export async function installAccountApi(
  page: Page | BrowserContext,
  options: AccountApiOptions = {},
): Promise<AccountApi> {
  let ordersMode = options.orders ?? 'ok';
  let ledgerMode = options.ledger ?? 'ok';
  const orderCount = options.orderCount ?? 25;
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const hold = () => {
    gate ??= new Promise((resolve) => {
      open = resolve;
    });
  };
  if (ordersMode === 'slow' || ledgerMode === 'slow') hold();

  const api: AccountApi = {
    orderRequests: [],
    ledgerRequests: [],
    patches: [],
    setOrders: (mode) => {
      ordersMode = mode;
      if (mode === 'slow') hold();
    },
    setLedger: (mode) => {
      ledgerMode = mode;
      if (mode === 'slow') hold();
    },
    release: () => open(),
  };

  const reply = async (route: Route, status: number, body: unknown) => {
    const origin = (await route.request().headerValue('origin')) ?? 'http://localhost:3100';
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
      },
      body: JSON.stringify(body),
    });
  };
  const failure = (code: string) => ({
    success: false,
    error: { code, message: `errors.${code}` },
  });

  // Like the server: a `page` below 1 or a `limit` outside 1..100 is a 400, not a quiet clamp.
  const answerPage = (route: Route, all: unknown[], url: URL) => {
    const pageNumber = Number(url.searchParams.get('page') ?? 1);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return reply(route, 400, failure('VALIDATION_ERROR'));
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply(route, 400, failure('VALIDATION_ERROR'));
    }
    return reply(route, 200, {
      success: true,
      data: all.slice((pageNumber - 1) * limit, pageNumber * limit),
      meta: { page: pageNumber, limit, total: all.length },
    });
  };

  await page.route(ORDER_LIST, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.fallback();
    const url = new URL(request.url());
    api.orderRequests.push(url);
    if (ordersMode === 'slow' && gate) await gate;
    if (ordersMode === 'error') return reply(route, 500, failure('INTERNAL_ERROR'));
    const wanted = url.searchParams.get('status')?.split(',');
    const all =
      ordersMode === 'empty'
        ? []
        : Array.from({ length: orderCount }, (_, index) => fakeOrder(index)).filter(
            (order) => wanted === undefined || wanted.includes(order.status),
          );
    return answerPage(route, all, url);
  });

  await page.route(LEDGER, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.fallback();
    const url = new URL(request.url());
    api.ledgerRequests.push(url);
    if (ledgerMode === 'slow' && gate) await gate;
    if (ledgerMode === 'error') return reply(route, 500, failure('INTERNAL_ERROR'));
    const all =
      ledgerMode === 'empty' ? [] : Array.from({ length: 23 }, (_, index) => fakeLedger(index));
    return answerPage(route, all, url);
  });

  // The profile language: recorded here (and refused on request), saved by the sign-in fakes.
  await page.route(ME, async (route) => {
    const request = route.request();
    if (request.method() !== 'PATCH') return route.fallback();
    const body: unknown = request.postDataJSON();
    api.patches.push(body);
    if (options.patchFails) return reply(route, 500, failure('INTERNAL_ERROR'));
    // Saved by the sign-in fake underneath (a later GET /me answers the new language).
    return route.fallback();
  });

  return api;
}
