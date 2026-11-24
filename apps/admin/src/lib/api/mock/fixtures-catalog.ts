// Catalog, settings and FX fixtures (AdminOps.dc.html `products`, `pricing`).
import {
  AdminCategoryListResponseSchema,
  AdminFxHistoryResponseSchema,
  AdminPricePreviewResponseSchema,
  AdminProductDetailResponseSchema,
  AdminProductListResponseSchema,
  AdminSettingsResponseSchema,
  type AdminPricePreviewResponse,
  type AdminProductDetailResponse,
} from '@repo/shared';
import { ago, mid } from './data-common';

export const CATEGORIES = AdminCategoryListResponseSchema.parse([
  {
    id: mid('cat', 1),
    slug: 'telegram',
    nameUz: 'Telegram',
    nameRu: 'Telegram',
    sort: 0,
    productsCount: 2,
  },
  {
    id: mid('cat', 2),
    slug: 'games',
    nameUz: 'O‘yinlar',
    nameRu: 'Игры',
    sort: 1,
    productsCount: 4,
  },
]);

/**
 * Per product: slug, category, name, delivery, active, packages [quantity, uz unit, ru unit,
 * supplier SKU prefix], routes [adapter, enabled, health]. Ids are `mk…` + (product − 1) × 10 + n,
 * so product 1 keeps the ids `mksku000001..6` / `mkroute000001..2` the screen tests use.
 */
const PRODUCT_ROWS = [
  ['telegram-stars', 1, 'Telegram Stars', 'TG_USERNAME', true],
  ['telegram-premium', 1, 'Telegram Premium', 'TG_USERNAME', true],
  ['pubg-mobile', 2, 'PUBG Mobile', 'GAME_ID', true],
  ['mobile-legends', 2, 'Mobile Legends', 'GAME_ID', true],
  ['steam', 2, 'Steam', 'STEAM_LOGIN', false],
  ['roblox', 2, 'Roblox', 'VOUCHER', true],
] as const;

const PACKAGES: Record<string, { sizes: number[]; uz: string; ru: string; sup: string | null }> = {
  'telegram-stars': {
    sizes: [50, 100, 250, 500, 1000, 2500],
    uz: '⭐',
    ru: '⭐',
    sup: null,
  },
  'telegram-premium': { sizes: [3, 6, 12], uz: 'oy', ru: 'мес.', sup: null },
  'pubg-mobile': {
    sizes: [60, 325, 660, 1800, 8100],
    uz: 'UC',
    ru: 'UC',
    sup: 'MB-UC-',
  },
  'mobile-legends': {
    sizes: [86, 172, 257, 706],
    uz: '💎',
    ru: '💎',
    sup: 'GS-ML-',
  },
  steam: { sizes: [], uz: '', ru: '', sup: null },
  roblox: { sizes: [400, 800, 1700], uz: 'Robux', ru: 'Robux', sup: 'VC-RBX-' },
};

const ROUTES: Record<string, [string, boolean, 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN'][]> = {
  'telegram-stars': [
    ['FRAGMENT', true, 'OK'],
    ['FRAGMENT_BACKUP', false, 'UNKNOWN'],
  ],
  'telegram-premium': [['FRAGMENT', true, 'OK']],
  'pubg-mobile': [
    ['MIDASBUY', true, 'OK'],
    ['UNIPIN', true, 'DEGRADED'],
  ],
  'mobile-legends': [['GAMESUP', true, 'OK']],
  steam: [],
  roblox: [['VOUCHER_STOCK', true, 'OK']],
};

/** What one unit of a product costs us (the live preview's input): currency and minor units. */
export const UNIT_COST: Record<string, { currency: 'TON' | 'USDT'; minor: bigint }> = {
  'telegram-stars': { currency: 'TON', minor: 4_350_000n },
  'telegram-premium': { currency: 'TON', minor: 1_160_000_000n },
  'pubg-mobile': { currency: 'USDT', minor: 16_000n },
  'mobile-legends': { currency: 'USDT', minor: 20_000n },
  steam: { currency: 'USDT', minor: 1_000_000n },
  roblox: { currency: 'USDT', minor: 12_500n },
};

export const MOCK_RATES = { TON: '43850.5', USDT: '12650' } as const;

const details: AdminProductDetailResponse[] = PRODUCT_ROWS.map(
  ([slug, category, name, delivery, active], index) => {
    const pack = PACKAGES[slug] ?? { sizes: [], uz: '', ru: '', sup: null };
    const stars = slug === 'telegram-stars';
    return AdminProductDetailResponseSchema.parse({
      id: mid('prod', index + 1),
      slug,
      categoryId: mid('cat', category),
      nameUz: name,
      nameRu: name,
      imageUrl: `/assets/products/${slug}.webp`,
      deliveryType: delivery,
      isActive: active,
      isFeatured: index < 2,
      sort: index,
      activeSkusCount: 0,
      routesEnabledCount: 0,
      descriptionUz: `${name} to‘g‘ridan-to‘g‘ri akkauntingizga.`,
      descriptionRu: `${name} прямо на ваш аккаунт.`,
      helpUz: null,
      helpRu: null,
      regionBadge: slug === 'pubg-mobile' ? 'UZ' : null,
      isAuto: true,
      allowCustomQty: stars,
      minQty: stars ? 50 : null,
      maxQty: stars ? 1_000_000 : null,
      skus: pack.sizes.map((quantity, n) => ({
        id: mid('sku', index * 10 + n + 1),
        tab: null,
        labelUz: `${quantity} ${pack.uz}`,
        labelRu: `${quantity} ${pack.ru}`,
        quantity,
        supplierSku: pack.sup === null ? null : `${pack.sup}${quantity}`,
        markupBps: stars && n === 5 ? 800 : 1200,
        minMarginTiyin: '200000',
        isActive: !(stars && n === 4),
        sort: n,
      })),
      routes: (ROUTES[slug] ?? []).map(([adapter, isEnabled, health], n) => ({
        id: mid('route', index * 10 + n + 1),
        adapter,
        priority: n * 10,
        isEnabled,
        health,
        healthCheckedAt: health === 'UNKNOWN' ? null : ago(2),
      })),
      updatedAt: ago(4_000),
    });
  },
);

/** The list row of a detail: the counts come from its packages and routes. */
export function rowOf(detail: AdminProductDetailResponse) {
  return {
    id: detail.id,
    slug: detail.slug,
    categoryId: detail.categoryId,
    nameUz: detail.nameUz,
    nameRu: detail.nameRu,
    imageUrl: detail.imageUrl,
    deliveryType: detail.deliveryType,
    isActive: detail.isActive,
    isFeatured: detail.isFeatured,
    sort: detail.sort,
    activeSkusCount: detail.skus.filter((sku) => sku.isActive).length,
    routesEnabledCount: detail.routes.filter((route) => route.isEnabled).length,
  };
}

export const PRODUCTS = AdminProductListResponseSchema.parse(details.map(rowOf));

export function productDetailFixture(id: string): AdminProductDetailResponse | undefined {
  const detail = details.find((product) => product.id === id);
  return detail === undefined ? undefined : AdminProductDetailResponseSchema.parse(detail);
}

/** The Stars packages' saved previews (fixed numbers of the screen tests; sku 6 is below min). */
export function pricePreviewFixture(skuId: string): AdminPricePreviewResponse {
  const low = skuId === mid('sku', 6);
  return AdminPricePreviewResponseSchema.parse({
    costCurrency: 'TON',
    costMinor: '742000000',
    fxRate: { id: mid('fx', 1), pair: 'TON_UZS', rate: '43850.5' },
    markupBps: low ? 800 : 1200,
    minMarginTiyin: '200000',
    priceTiyin: low ? '3514000' : '3644000',
    marginTiyin: low ? '160000' : '290000',
    belowMinMargin: low,
  });
}
export const SETTINGS = AdminSettingsResponseSchema.parse({
  items: [
    ['TOPUP_MIN_TIYIN', '500000', 'TIYIN', 'env'],
    ['TOPUP_MAX_TIYIN', '1000000000', 'TIYIN', 'env'],
    ['TOPUP_STEP_TIYIN', '100000', 'TIYIN', 'env'],
    ['TOPUP_DAILY_MAX_TIYIN', '500000000', 'TIYIN', 'env'],
    ['TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN', '100000000', 'TIYIN', 'env'],
    ['PRICE_TOLERANCE_BPS', '300', 'BPS', 'env'],
    ['QUOTE_TTL_MS', '120000', 'MS', 'env'],
    ['FX_MAX_AGE_MS', '900000', 'MS', 'env'],
    ['FX_MAX_JUMP_BPS', '1000', 'BPS', 'constant'],
    ['ADMIN_CONFIRM_THRESHOLD_TIYIN', '10000000', 'TIYIN', 'env'],
    ['ADMIN_OPERATOR_REFUND_MAX_TIYIN', '50000000', 'TIYIN', 'env'],
    ['ADMIN_OTP_DAILY_MAX', '30', 'COUNT', 'env'],
    ['ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN', '500000000', 'TIYIN', 'env'],
  ].map(([key, value, unit, source]) => ({ key, value, unit, source })),
});

const USDT = ['12650', '12655.5', '12640', '12672', '12668', '12690', '12680'];
const TON = ['3.46', '3.41', '3.38', '3.44', '3.49', '3.47', '3.45'];

export const FX_HISTORY = AdminFxHistoryResponseSchema.parse(
  USDT.flatMap((usdt, index) => {
    const minutes = (USDT.length - 1 - index) * 1440 + 30;
    return [
      {
        id: mid('fxu', index),
        pair: 'USDT_UZS',
        rate: usdt,
        source: 'binance-p2p',
        createdAt: ago(minutes),
      },
      {
        id: mid('fxt', index),
        pair: 'TON_USDT',
        rate: TON[index] ?? '3.4',
        source: 'bybit',
        createdAt: ago(minutes),
      },
    ];
  }).reverse(),
);
