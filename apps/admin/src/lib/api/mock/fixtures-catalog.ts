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

const PRODUCT_ROWS = [
  ['telegram-stars', 1, 'Telegram Stars', 'TG_USERNAME', true, 6, 1],
  ['telegram-premium', 1, 'Telegram Premium', 'TG_USERNAME', true, 3, 1],
  ['pubg-mobile', 2, 'PUBG Mobile', 'GAME_ID', true, 8, 2],
  ['mobile-legends', 2, 'Mobile Legends', 'GAME_ID', true, 7, 1],
  ['steam', 2, 'Steam', 'STEAM_LOGIN', false, 0, 0],
  ['roblox', 2, 'Roblox', 'VOUCHER', true, 4, 1],
] as const;

export const PRODUCTS = AdminProductListResponseSchema.parse(
  PRODUCT_ROWS.map(([slug, category, name, delivery, active, skus, routes], index) => ({
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
    activeSkusCount: skus,
    routesEnabledCount: routes,
  })),
);

export function productDetailFixture(id: string): AdminProductDetailResponse | undefined {
  const row = PRODUCTS.find((product) => product.id === id);
  if (row === undefined) return undefined;
  const stars = [50, 100, 250, 500, 1000, 2500];
  return AdminProductDetailResponseSchema.parse({
    ...row,
    descriptionUz: 'Telegram yulduzlari to‘g‘ridan-to‘g‘ri akkauntingizga.',
    descriptionRu: 'Звёзды Telegram прямо на ваш аккаунт.',
    helpUz: null,
    helpRu: null,
    regionBadge: null,
    isAuto: true,
    allowCustomQty: false,
    minQty: null,
    maxQty: null,
    skus: stars.map((quantity, index) => ({
      id: mid('sku', index + 1),
      tab: null,
      labelUz: `${quantity} ⭐`,
      labelRu: `${quantity} ⭐`,
      quantity,
      supplierSku: null,
      markupBps: index === 5 ? 800 : 1200,
      minMarginTiyin: '200000',
      isActive: index !== 4,
      sort: index,
    })),
    routes: [
      {
        id: mid('route', 1),
        adapter: 'FRAGMENT',
        priority: 0,
        isEnabled: true,
        health: 'OK',
        healthCheckedAt: ago(2),
      },
      {
        id: mid('route', 2),
        adapter: 'FRAGMENT_BACKUP',
        priority: 10,
        isEnabled: false,
        health: 'UNKNOWN',
        healthCheckedAt: null,
      },
    ],
    updatedAt: ago(4_000),
  });
}

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
