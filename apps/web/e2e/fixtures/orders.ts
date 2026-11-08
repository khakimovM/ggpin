import type { BrowserContext, Page, Route } from '@playwright/test';
import type { IssuedQuote, ProductApi } from './product';

// A fake of `POST /orders` and `GET /orders/:id`, shaped like docs/04 (a phase 5 DRAFT). It reads
// the quotes the product fake handed out, so a price on the order page is the one the visitor
// confirmed. The "server" here decides everything (balance, expiry, status), as the real one will.

const API = 'http://localhost:5000/api/v1';
const ORDERS = `${API}/orders`;
const ORDER = /^http:\/\/localhost:5000\/api\/v1\/orders\/([^/?]+)/;

export type OrderStatus =
  | 'PAID'
  | 'QUEUED'
  | 'PROCESSING'
  | 'HELD'
  | 'NEEDS_REVIEW'
  | 'DELIVERED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED';

export type PostMode =
  | 'ok'
  | 'frozen'
  | 'rateLimited'
  | 'error'
  | 'conflict'
  /** The first request never reaches the server (no order); later ones are answered. */
  | 'networkOnce'
  /** The first request CREATES the order, but the answer is lost on the way back. */
  | 'lostOnce'
  /** The first request CREATES the order and then hangs: the page is reloaded mid-request. */
  | 'hangOnce'
  /** A proxy answers with an HTML 404 page (no envelope); the request never reaches the API. */
  | 'proxy404';

/** The wallet of the fake server: 1 000 000 so'm. Pass the same number to `installCatalogApi`. */
export const DEFAULT_BALANCE_TIYIN = '100000000';

export const FULL_FLOW: OrderStatus[] = ['PAID', 'QUEUED', 'PROCESSING', 'DELIVERED'];

export interface OrdersApiOptions {
  balanceTiyin?: string;
  post?: PostMode;
  /** The status each successive `GET /orders/:id` answers; the last one repeats. */
  statuses?: OrderStatus[];
  /** The code of a delivered voucher order. */
  voucher?: string;
  get?: 'ok' | 'notFound' | 'error';
  /** Milliseconds `POST /orders` takes (to see the progress state). */
  postDelayMs?: number;
  /** Milliseconds `GET /orders/:id` takes (to see the skeleton). */
  getDelayMs?: number;
  /** An order that exists without a purchase in the test (to open the order page directly). */
  preset?: Pick<IssuedQuote, 'productSlug' | 'productName' | 'quantity' | 'totalTiyin'>;
}

export interface OrdersApi {
  /** Every `POST /orders` body and its `Idempotency-Key`. */
  posts: Array<{ quoteId: string; key: string | null }>;
  orderGets: () => number;
  setStatuses: (statuses: OrderStatus[]) => void;
  setPost: (mode: PostMode) => void;
  setGet: (mode: NonNullable<OrdersApiOptions['get']>) => void;
}

const envelope = (data: unknown) => ({ success: true, data });
const failure = (code: string, details?: unknown) => ({
  success: false,
  error: { code, message: `errors.${code}`, ...(details === undefined ? {} : { details }) },
});

const at = (base: number, seconds: number) => new Date(base + seconds * 1000).toISOString();

interface Known {
  id: string;
  quoteId: string;
  at: number;
}

export async function installOrdersApi(
  page: Page | BrowserContext,
  product: ProductApi,
  options: OrdersApiOptions = {},
): Promise<OrdersApi> {
  let statuses = options.statuses ?? FULL_FLOW;
  let postMode: PostMode = options.post ?? 'ok';
  let getMode = options.get ?? 'ok';
  let gets = 0;
  let droppedOnce = false;
  const created = new Map<string, Known>();
  const byKey = new Map<string, string>();
  const api: OrdersApi = {
    posts: [],
    orderGets: () => gets,
    setStatuses: (next) => {
      statuses = next;
      gets = 0;
    },
    setPost: (mode) => {
      postMode = mode;
    },
    setGet: (mode) => {
      getMode = mode;
    },
  };

  // The quote behind a preset order (no purchase happened in the test).
  const stand = (id: string): IssuedQuote => ({
    id,
    totalTiyin: options.preset?.totalTiyin ?? '0',
    productSlug: options.preset?.productSlug ?? 'telegram-stars',
    productName: options.preset?.productName ?? 'Telegram Stars',
    skuId: null,
    quantity: options.preset?.quantity ?? 1,
    username: 'dilnoza_k',
    displayName: 'Dilnoza K.',
  });
  const quoteOf = (known: Known): IssuedQuote =>
    product.quotes.get(known.quoteId) ?? stand(known.quoteId);

  const reply = async (route: Route, status: number, body: unknown) => {
    const origin = (await route.request().headerValue('origin')) ?? 'http://localhost:3100';
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'Retry-After',
        'cache-control': 'no-store',
      },
      body: JSON.stringify(body),
    });
  };

  const view = (known: Known, status: OrderStatus) => {
    const quote = quoteOf(known);
    return {
      id: known.id,
      number: 1000 + created.size,
      status,
      productId:
        quote.productSlug === 'telegram-premium' ? 'id_telegram_premium' : 'id_telegram_stars',
      productSlug: quote.productSlug,
      productName: quote.productName,
      skuId: quote.skuId,
      quantity: quote.quantity,
      recipient: { displayName: quote.displayName, fields: { username: quote.username } },
      priceTiyin: quote.totalTiyin,
      discountTiyin: '0',
      totalTiyin: quote.totalTiyin,
      currency: 'UZS',
      createdAt: at(known.at, 0),
      deliveredAt: status === 'DELIVERED' ? at(known.at, 70) : null,
    };
  };

  await page.route(ORDERS, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const body = request.postDataJSON() as { quoteId: string };
    const key = (await request.headerValue('idempotency-key')) ?? null;
    api.posts.push({ quoteId: body.quoteId, key });
    if (options.postDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.postDelayMs));
    }

    if (postMode === 'networkOnce' && !droppedOnce) {
      droppedOnce = true;
      return route.abort('connectionfailed');
    }
    if (postMode === 'proxy404') {
      const origin = (await request.headerValue('origin')) ?? 'http://localhost:3100';
      return route.fulfill({
        status: 404,
        contentType: 'text/html',
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
        },
        body: '<html><body><h1>404 Not Found</h1></body></html>',
      });
    }
    if (postMode === 'frozen') return reply(route, 403, failure('PURCHASE_FROZEN'));
    if (postMode === 'rateLimited') return reply(route, 429, failure('RATE_LIMITED'));
    if (postMode === 'error') return reply(route, 500, failure('INTERNAL_ERROR'));
    if (postMode === 'conflict') return reply(route, 409, failure('IDEMPOTENCY_CONFLICT'));

    // The same key is the same order, never a second charge.
    const earlier = key === null ? undefined : byKey.get(key);
    const again = earlier === undefined ? undefined : created.get(earlier);
    if (again) return reply(route, 201, envelope({ order: view(again, 'PAID') }));

    const quote = product.quotes.get(body.quoteId);
    if (quote === undefined) return reply(route, 404, failure('NOT_FOUND'));
    if (product.deadQuotes.has(body.quoteId)) return reply(route, 410, failure('QUOTE_EXPIRED'));
    const balance = BigInt(options.balanceTiyin ?? DEFAULT_BALANCE_TIYIN);
    const total = BigInt(quote.totalTiyin);
    if (total > balance) {
      return reply(
        route,
        422,
        failure('INSUFFICIENT_BALANCE', {
          balance: balance.toString(),
          required: total.toString(),
          shortfall: (total - balance).toString(),
        }),
      );
    }
    const known: Known = { id: `order_${created.size + 1}`, quoteId: body.quoteId, at: Date.now() };
    created.set(known.id, known);
    if (key !== null) byKey.set(key, known.id);
    if (postMode === 'lostOnce' && !droppedOnce) {
      droppedOnce = true;
      return route.abort('connectionfailed');
    }
    if (postMode === 'hangOnce' && !droppedOnce) {
      droppedOnce = true;
      // The order exists; the answer never comes (the test reloads or closes the page).
      return new Promise<void>(() => undefined);
    }
    return reply(route, 201, envelope({ order: view(known, 'PAID') }));
  });

  await page.route(ORDER, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.fallback();
    const id = ORDER.exec(request.url())?.[1] ?? '';
    if (options.getDelayMs) await new Promise((resolve) => setTimeout(resolve, options.getDelayMs));
    if (getMode === 'error') return reply(route, 500, failure('INTERNAL_ERROR'));
    const known =
      created.get(id) ?? (options.preset ? { id, quoteId: 'preset', at: Date.now() } : undefined);
    if (getMode === 'notFound' || known === undefined) {
      return reply(route, 404, failure('NOT_FOUND'));
    }
    const status = statuses[Math.min(gets, statuses.length - 1)] ?? 'PAID';
    gets += 1;
    const reached = statuses.slice(0, Math.min(gets, statuses.length));
    const timeline = [...new Set(reached)].map((s, index) => ({
      status: s,
      at: at(known.at, index * 5),
    }));
    return reply(
      route,
      200,
      envelope({
        ...view(known, status),
        timeline,
        voucher: status === 'DELIVERED' && options.voucher ? { code: options.voucher } : null,
      }),
    );
  });

  return api;
}
