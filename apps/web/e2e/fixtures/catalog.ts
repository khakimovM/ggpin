import type { BrowserContext, Page, Route } from '@playwright/test';

// A fake of the catalog and wallet endpoints, shaped like docs/04 (envelope, `meta`, tiyin
// strings, product images as paths of the site). It is layered on top of another fake API
// (`installFakeApi`, `installTgApi`): it answers `/catalog/*` and `/me/wallet`, and lets every other
// request fall through to the fake registered before it.

const CATALOG_PATTERN = /^http:\/\/localhost:5000\/api\/v1\/(catalog\/|me\/wallet)/;

type Names = { uz: string; ru: string };

interface FakeCategory {
  slug: string;
  name: Names;
}

export interface FakeProduct {
  id: string;
  slug: string;
  categorySlug: string;
  name: string;
  imageUrl: string;
  regionBadge: string | null;
  deliveryType: 'TG_USERNAME' | 'GAME_ID' | 'STEAM_LOGIN' | 'VOUCHER' | 'USERNAME';
  isAuto: boolean;
  isFeatured: boolean;
  inStock: boolean;
  fromPriceTiyin: string | null;
}

export const CATEGORIES: FakeCategory[] = [
  { slug: 'telegram', name: { uz: 'Telegram', ru: 'Telegram' } },
  { slug: 'games', name: { uz: 'O‘yinlar', ru: 'Игры' } },
  { slug: 'platforms', name: { uz: 'Platformalar', ru: 'Платформы' } },
];

const product = (
  slug: string,
  name: string,
  categorySlug: string,
  extra: Partial<FakeProduct> = {},
): FakeProduct => ({
  id: `id_${slug}`,
  slug,
  categorySlug,
  name,
  imageUrl: `/assets/products/${slug}.svg`,
  regionBadge: null,
  deliveryType: 'GAME_ID',
  isAuto: true,
  isFeatured: false,
  inStock: true,
  fromPriceTiyin: '1000000',
  ...extra,
});

export const PRODUCTS: FakeProduct[] = [
  product('telegram-stars', 'Telegram Stars', 'telegram', {
    deliveryType: 'TG_USERNAME',
    fromPriceTiyin: '550000',
  }),
  product('telegram-premium', 'Telegram Premium', 'telegram', {
    deliveryType: 'TG_USERNAME',
    fromPriceTiyin: '16500000',
  }),
  product('pubg-mobile', 'PUBG Mobile', 'games', {
    regionBadge: 'GLOBAL',
    isFeatured: true,
    fromPriceTiyin: '1215000',
  }),
  product('mobile-legends', 'Mobile Legends', 'games', { fromPriceTiyin: '1990000' }),
  // No fresh price, and out of stock: no price line, a "sold out" chip.
  product('free-fire', 'Free Fire', 'games', {
    inStock: false,
    fromPriceTiyin: null,
    imageUrl: '/assets/products/missing.svg',
  }),
  product('steam', 'Steam', 'platforms', {
    deliveryType: 'STEAM_LOGIN',
    regionBadge: 'GLOBAL',
    fromPriceTiyin: '5000000',
  }),
  product('roblox', 'Roblox', 'platforms', {
    deliveryType: 'VOUCHER',
    isAuto: false,
    fromPriceTiyin: '12245000',
  }),
];

/** Image slugs that exist; `missing.svg` deliberately 404s so the fallback shows. */
const SVG = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><rect width="120" height="90" fill="#6670ff"/><text x="60" y="52" font-size="14" text-anchor="middle" fill="#fff">${label}</text></svg>`;

type Mode = 'ok' | 'error' | 'drop' | 'slow';

export interface CatalogApiOptions {
  products?: Mode | 'empty';
  categories?: Mode | 'empty';
  wallet?: Mode;
  balanceTiyin?: string;
  coins?: string;
  /** Categories whose product list comes back empty (a category that emptied meanwhile). */
  emptyCategories?: string[];
  /** Categories whose product request fails with a 500 (the others answer). */
  failCategories?: string[];
}

export interface CatalogApi {
  /** Every catalog and wallet request, in order. */
  requests: URL[];
  productRequests: () => URL[];
  /** Holds every `slow` answer until `release()`. */
  hold: () => void;
  release: () => void;
  setBalance: (tiyin: string) => void;
}

const envelope = (data: unknown, meta?: unknown) => ({
  success: true,
  data,
  ...(meta === undefined ? {} : { meta }),
});
const failure = (code: string) => ({ success: false, error: { code, message: `errors.${code}` } });

export async function installCatalogApi(
  page: Page | BrowserContext,
  options: CatalogApiOptions = {},
): Promise<CatalogApi> {
  const state = { balance: options.balanceTiyin ?? '8540000', coins: options.coins ?? '120' };
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const api: CatalogApi = {
    requests: [],
    productRequests: () => api.requests.filter((url) => url.pathname.endsWith('/catalog/products')),
    hold: () => {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => open(),
    setBalance: (tiyin) => {
      state.balance = tiyin;
    },
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

  async function answerWith(route: Route, mode: Mode | 'empty', ok: () => unknown, meta?: unknown) {
    if (mode === 'drop') return route.abort('connectionfailed');
    if (mode === 'error') return reply(route, 500, failure('INTERNAL_ERROR'));
    if (mode === 'slow' && gate) await gate;
    return reply(route, 200, envelope(ok(), meta));
  }

  await page.route(CATALOG_PATTERN, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fallback();
    const url = new URL(request.url());
    api.requests.push(url);
    const locale = url.searchParams.get('locale') === 'ru' ? 'ru' : 'uz';

    if (url.pathname.endsWith('/me/wallet')) {
      return answerWith(route, options.wallet ?? 'ok', () => ({
        balanceTiyin: state.balance,
        coins: state.coins,
        currency: 'UZS',
      }));
    }
    if (url.pathname.endsWith('/catalog/categories')) {
      const mode = options.categories ?? 'ok';
      return answerWith(route, mode, () =>
        mode === 'empty'
          ? []
          : CATEGORIES.map((category) => ({
              slug: category.slug,
              name: category.name[locale],
              productCount: PRODUCTS.filter((p) => p.categorySlug === category.slug).length,
            })),
      );
    }
    if (url.pathname.endsWith('/catalog/products')) {
      const category = url.searchParams.get('category');
      const mode =
        category !== null && options.failCategories?.includes(category)
          ? 'error'
          : (options.products ?? 'ok');
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const items = PRODUCTS.filter(
        (p) =>
          (category === null || p.categorySlug === category) &&
          !(category !== null && options.emptyCategories?.includes(category)) &&
          (q === '' || p.name.toLowerCase().includes(q)),
      );
      const list = mode === 'empty' ? [] : items;
      return answerWith(route, mode, () => list, {
        page: 1,
        limit: Number(url.searchParams.get('limit') ?? 20),
        total: list.length,
      });
    }
    return route.fallback();
  });

  // Product pictures: every slug but `missing` is a small SVG of the site.
  await page.route(/\/assets\/products\/[^/]+\.svg(\?.*)?$/, async (route) => {
    const slug = /products\/([^/.]+)\.svg/.exec(route.request().url())?.[1] ?? '';
    if (slug === 'missing') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'image/svg+xml', body: SVG(slug) });
  });

  return api;
}
