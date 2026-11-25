import type { BrowserContext, Page, Route } from '@playwright/test';
import { routeUntilClosed } from '../support/route-until-closed';
import {
  MONTHS,
  PREMIUM_PRICE,
  STAR_TIYIN,
  detail,
  type Lang,
  type ProductMode,
} from './product-detail';

export { PREMIUM_PRICE, STAR_TIYIN, type ProductMode } from './product-detail';

// A fake of the product detail, `POST /recipients/validate` and `POST /quotes`, shaped like docs/04.
// It sits on top of the catalog fake (`installCatalogApi`): it answers the three routes below and
// lets everything else fall through. The "server" here is the one that works out prices (a test
// double), so the page under test is shown strings it did not compute.

const API = 'http://localhost:5000/api/v1';
const PRODUCT = /^http:\/\/localhost:5000\/api\/v1\/catalog\/products\/([^/?]+)/;
const RECIPIENTS = `${API}/recipients/validate`;
const QUOTES = `${API}/quotes`;

/** The n-th token the fake server hands out (1, 2, ...): each lookup gets a fresh one. */
export const tokenN = (n: number) => `e2eRecipientToken${n}`.padEnd(43, 'x');
/** The first one. */
export const TOKEN = tokenN(1);

/** `hasPremium`: the blocking 422 (`blocked`); `hasPremiumExtends`: 200 with the warning (`has`). */
export type RecipientReply =
  | 'found'
  | 'notFound'
  | 'invalid'
  | 'down'
  | 'hasPremium'
  | 'hasPremiumExtends'
  | 'rateLimited'
  | 'slow';
export type QuoteMode = 'ok' | 'priceUnavailable' | 'rateLimited' | 'error' | 'recipientInvalid';

export interface ProductApiOptions {
  product?: ProductMode;
  /** Give the product a "Qanday topaman?" text (a hostile one, to prove it is only text). */
  help?: boolean;
  /** Reply per username (default: found). */
  recipients?: Record<string, RecipientReply>;
  quote?: QuoteMode;
}

/** A quote the fake server handed out; the orders fake reads it to price and to expire. */
export interface IssuedQuote {
  id: string;
  totalTiyin: string;
  productSlug: 'telegram-stars' | 'telegram-premium';
  productName: string;
  skuId: string | null;
  quantity: number;
  username: string;
  displayName: string;
}

export interface ProductApi {
  /** Every quote handed out, in order; `dead` ones are answered 410 QUOTE_EXPIRED by the orders fake. */
  quotes: Map<string, IssuedQuote>;
  deadQuotes: Set<string>;
  /** The server forgets every recipient token (they live 10 minutes): a quote says RECIPIENT_INVALID. */
  killTokens: () => void;
  /** Every quote handed out so far is expired for the server (the page's clock is moved separately). */
  expireQuotes: () => void;
  recipientBodies: Array<Record<string, unknown>>;
  quoteBodies: Array<Record<string, unknown>>;
  setQuote: (mode: QuoteMode) => void;
  setProduct: (mode: ProductMode) => void;
  hold: () => void;
  release: () => void;
}

const envelope = (data: unknown) => ({ success: true, data });
const failure = (code: string, details?: unknown) => ({
  success: false,
  error: { code, message: `errors.${code}`, ...(details === undefined ? {} : { details }) },
});

export async function installProductApi(
  page: Page | BrowserContext,
  options: ProductApiOptions = {},
): Promise<ProductApi> {
  let quoteMode: QuoteMode = options.quote ?? 'ok';
  const issued = new Map<string, number>();
  const deadTokens = new Set<string>();
  let productMode: ProductMode = options.product ?? 'ok';
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const api: ProductApi = {
    quotes: new Map(),
    deadQuotes: new Set(),
    killTokens: () => {
      for (const token of issued.keys()) deadTokens.add(token);
    },
    expireQuotes: () => {
      for (const id of api.quotes.keys()) api.deadQuotes.add(id);
    },
    recipientBodies: [],
    quoteBodies: [],
    setQuote: (mode) => {
      quoteMode = mode;
    },
    setProduct: (mode) => {
      productMode = mode;
    },
    hold: () => {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => open(),
  };

  const reply = async (
    route: Route,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ) => {
    const origin = (await route.request().headerValue('origin')) ?? 'http://localhost:3100';
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'Retry-After',
        'cache-control': 'no-store',
        ...extra,
      },
      body: JSON.stringify(body),
    });
  };

  await routeUntilClosed(page, PRODUCT, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fallback();
    const url = new URL(request.url());
    const slug = PRODUCT.exec(request.url())?.[1] ?? '';
    const lang: Lang = url.searchParams.get('locale') === 'ru' ? 'ru' : 'uz';
    const mode = productMode;
    if (mode === 'drop') return route.abort('connectionfailed');
    if (mode === 'error') return reply(route, 500, failure('INTERNAL_ERROR'));
    if (mode === 'missing') return reply(route, 404, failure('NOT_FOUND'));
    if (mode === 'slow' && gate) await gate;
    if (slug !== 'telegram-stars' && slug !== 'telegram-premium') {
      return reply(route, 404, failure('NOT_FOUND'));
    }
    return reply(route, 200, envelope(detail(slug, lang, mode, options)));
  });

  await routeUntilClosed(page, RECIPIENTS, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fallback();
    const body = request.postDataJSON() as { input: { username: string } };
    api.recipientBodies.push(body);
    const username = body.input.username;
    const answer = options.recipients?.[username] ?? 'found';
    const issue = () => {
      const token = tokenN(issued.size + 1);
      issued.set(token, Date.now());
      return token;
    };
    if (answer === 'slow' && gate) await gate;
    switch (answer) {
      case 'notFound':
        return reply(route, 422, failure('RECIPIENT_NOT_FOUND'));
      case 'invalid':
        return reply(route, 422, failure('RECIPIENT_INVALID'));
      case 'hasPremium':
        return reply(route, 422, failure('RECIPIENT_HAS_PREMIUM'));
      case 'down':
        return reply(route, 503, failure('RECIPIENT_CHECK_UNAVAILABLE'));
      case 'rateLimited':
        return reply(route, 429, failure('RATE_LIMITED'), { 'retry-after': '2' });
      default:
        return reply(
          route,
          200,
          envelope({
            recipientToken: issue(),
            displayName: username === 'dilnoza_k' ? 'Dilnoza K.' : 'Aziz',
            warnings:
              answer === 'hasPremiumExtends'
                ? [{ code: 'PREMIUM_EXTENDS', message: 'warnings.premiumExtends' }]
                : [],
          }),
        );
    }
  });

  await routeUntilClosed(page, QUOTES, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fallback();
    const body = request.postDataJSON() as {
      productId?: string;
      skuId?: string;
      quantity?: number;
      recipientToken: string;
    };
    api.quoteBodies.push(body);
    const tokenDead = !issued.has(body.recipientToken) || deadTokens.has(body.recipientToken);
    if (quoteMode === 'recipientInvalid' || tokenDead) {
      return reply(route, 422, failure('RECIPIENT_INVALID'));
    }
    if (quoteMode === 'priceUnavailable') return reply(route, 503, failure('PRICE_UNAVAILABLE'));
    if (quoteMode === 'rateLimited') {
      return reply(route, 429, failure('RATE_LIMITED'), { 'retry-after': '4' });
    }
    if (quoteMode === 'error') return reply(route, 500, failure('INTERNAL_ERROR'));
    const total =
      body.quantity !== undefined
        ? String(BigInt(body.quantity) * STAR_TIYIN)
        : (PREMIUM_PRICE[body.skuId ?? ''] ?? '0');
    const quoteId = `quote_${api.quoteBodies.length}`;
    const premium = body.productId === 'id_telegram_premium';
    const sku = premium ? MONTHS.uz.find(([id]) => id === body.skuId) : undefined;
    api.quotes.set(quoteId, {
      id: quoteId,
      totalTiyin: total,
      productSlug: premium ? 'telegram-premium' : 'telegram-stars',
      productName: premium ? 'Telegram Premium' : 'Telegram Stars',
      skuId: body.skuId ?? null,
      quantity: body.quantity ?? sku?.[1] ?? 1,
      username: 'aziz_k',
      displayName: 'Aziz',
    });
    return reply(
      route,
      201,
      envelope({
        quoteId,
        priceTiyin: total,
        discountTiyin: '0',
        totalTiyin: total,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        recipient: { username: 'aziz_k', displayName: 'Aziz' },
        currency: 'UZS',
      }),
    );
  });

  return api;
}
