import type { BrowserContext, Page, Route } from '@playwright/test';

// A fake of the product detail, `POST /recipients/validate` and `POST /quotes`, shaped like docs/04.
// It sits on top of the catalog fake (`installCatalogApi`): it answers the three routes below and
// lets everything else fall through. The "server" here is the one that works out prices (a test
// double), so the page under test is shown strings it did not compute.

const API = 'http://localhost:5000/api/v1';
const PRODUCT = /^http:\/\/localhost:5000\/api\/v1\/catalog\/products\/([^/?]+)/;
const RECIPIENTS = `${API}/recipients/validate`;
const QUOTES = `${API}/quotes`;

type Lang = 'uz' | 'ru';
/** The n-th token the fake server hands out (1, 2, ...): each lookup gets a fresh one. */
export const tokenN = (n: number) => `e2eRecipientToken${n}`.padEnd(43, 'x');
/** The first one. */
export const TOKEN = tokenN(1);
/** Tiyin per star: 220 so'm. */
export const STAR_TIYIN = 22_000n;
export const PREMIUM_PRICE: Record<string, string> = {
  m3: '16500000',
  m6: '22000000',
  m12: '39600000',
};

export type RecipientReply =
  'found' | 'notFound' | 'invalid' | 'down' | 'hasPremium' | 'rateLimited' | 'slow';
export type QuoteMode = 'ok' | 'priceUnavailable' | 'rateLimited' | 'error' | 'recipientInvalid';
export type ProductMode = 'ok' | 'error' | 'drop' | 'slow' | 'missing' | 'soldOut' | 'unsupported';

export interface ProductApiOptions {
  product?: ProductMode;
  /** Give the product a "Qanday topaman?" text (a hostile one, to prove it is only text). */
  help?: boolean;
  /** Reply per username (default: found). */
  recipients?: Record<string, RecipientReply>;
  quote?: QuoteMode;
  /** Seconds a quote lives (default 600). */
  quoteTtlSec?: number;
  /** Seconds a recipient token lives (default 600, like the contract); then a quote says RECIPIENT_INVALID. */
  tokenTtlSec?: number;
}

export interface ProductApi {
  recipientBodies: Array<Record<string, unknown>>;
  quoteBodies: Array<Record<string, unknown>>;
  setQuote: (mode: QuoteMode) => void;
  setProduct: (mode: ProductMode) => void;
  hold: () => void;
  release: () => void;
}

const SKUS = {
  'telegram-stars': [
    ['s50', 50, '50 ⭐', '1100000'],
    ['s100', 100, '100 ⭐', '2200000'],
    ['s250', 250, '250 ⭐', '5500000'],
    ['s500', 500, '500 ⭐', '11000000'],
    ['s1000', 1000, '1 000 ⭐', '22000000'],
    ['s2500', 2500, '2 500 ⭐', '55000000'],
  ],
} as const;
const MONTHS: Record<Lang, [string, number, string][]> = {
  uz: [
    ['m3', 3, '3 oylik'],
    ['m6', 6, '6 oylik'],
    ['m12', 12, '12 oylik'],
  ],
  ru: [
    ['m3', 3, '3 месяца'],
    ['m6', 6, '6 месяцев'],
    ['m12', 12, '12 месяцев'],
  ],
};

const HOSTILE_HELP: Record<Lang, string> = {
  uz: 'Telegramni oching va profilingizga kiring.\n<img src=x onerror="window.__xss=1"> Username “@” belgisidan keyin turadi.',
  ru: 'Откройте Telegram и зайдите в профиль.\n<img src=x onerror="window.__xss=1"> Username идёт после «@».',
};

function detail(slug: string, lang: Lang, mode: ProductMode, options: ProductApiOptions) {
  const premium = slug === 'telegram-premium';
  const base = {
    id: premium ? 'id_telegram_premium' : 'id_telegram_stars',
    slug,
    name: premium ? 'Telegram Premium' : 'Telegram Stars',
    description:
      lang === 'uz'
        ? premium
          ? 'O‘zingizga yoki do‘stingizga Premium obuna'
          : 'Sovg‘alar, reaksiyalar va obunalar uchun yulduzlar'
        : premium
          ? 'Подписка Premium для себя или друга'
          : 'Звёзды для подарков, реакций и подписок',
    help: options.help ? HOSTILE_HELP[lang] : null,
    imageUrl: `/assets/products/${slug}.svg`,
    deliveryType: 'TG_USERNAME',
    regionBadge: 'GLOBAL',
    isAuto: true,
    allowCustomQty: !premium,
    minQty: premium ? null : 50,
    maxQty: premium ? null : 100_000,
    inputSchema:
      mode === 'unsupported'
        ? []
        : [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
    skus: premium
      ? MONTHS[lang].map(([id, quantity, label]) => ({
          id,
          label,
          quantity,
          tab: null,
          fromPriceTiyin: PREMIUM_PRICE[id] ?? null,
        }))
      : SKUS['telegram-stars'].map(([id, quantity, label, price]) => ({
          id,
          label,
          quantity,
          tab: null,
          fromPriceTiyin: price,
        })),
    unitPriceTiyin: premium ? null : String(STAR_TIYIN),
    stock: mode === 'soldOut' ? 0 : null,
    currency: 'UZS',
  };
  return base;
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
  let productMode: ProductMode = options.product ?? 'ok';
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const api: ProductApi = {
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

  await page.route(PRODUCT, async (route) => {
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

  await page.route(RECIPIENTS, async (route) => {
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
            warnings: [],
          }),
        );
    }
  });

  await page.route(QUOTES, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fallback();
    const body = request.postDataJSON() as {
      skuId?: string;
      quantity?: number;
      recipientToken: string;
    };
    api.quoteBodies.push(body);
    const issuedAt = issued.get(body.recipientToken);
    const tokenDead =
      issuedAt === undefined || Date.now() - issuedAt > (options.tokenTtlSec ?? 600) * 1000;
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
    return reply(
      route,
      201,
      envelope({
        quoteId: `quote_${api.quoteBodies.length}`,
        priceTiyin: total,
        discountTiyin: '0',
        totalTiyin: total,
        expiresAt: new Date(Date.now() + (options.quoteTtlSec ?? 600) * 1000).toISOString(),
        recipient: { username: 'aziz_k', displayName: 'Aziz' },
        currency: 'UZS',
      }),
    );
  });

  return api;
}
