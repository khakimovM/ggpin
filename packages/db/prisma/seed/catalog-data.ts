// Phase-3 reference data: the Telegram category with Stars and Premium (docs/11 phase 3).
// Texts: Uzbek uses ‘ (U+2018) in o‘/g‘ and ʼ (U+02BC) for the tutuq belgisi; brand names are
// not translated (rules/35-i18n.md). Prices are NOT here: sell price = cost snapshot x markup.
import type { DeliveryType } from '../../src/index.js';

export interface SeedSku {
  /** Stars count, or months for Premium. With `tab`, identifies the SKU inside its product. */
  quantity: number;
  tab: string | null;
  labelUz: string;
  labelRu: string;
}

export interface SeedRoute {
  adapter: string;
  priority: number;
  isEnabled: boolean;
}

export interface SeedProduct {
  slug: string;
  nameUz: string;
  nameRu: string;
  descriptionUz: string;
  descriptionRu: string;
  /** Web asset path (served by apps/web), not an absolute URL. */
  imageUrl: string;
  regionBadge: string;
  deliveryType: DeliveryType;
  /** Validated with ProductInputSchema before anything is written. */
  inputSchema: unknown;
  allowCustomQty: boolean;
  minQty: number | null;
  maxQty: number | null;
  sort: number;
  routes: SeedRoute[];
  skus: SeedSku[];
}

export interface SeedCategory {
  slug: string;
  nameUz: string;
  nameRu: string;
  sort: number;
  products: SeedProduct[];
}

/** Placeholder pricing (owner answer Q8): 10% markup, no minimum margin until the owner decides. */
export const SEED_MARKUP_BPS = 1000;
export const SEED_MIN_MARGIN_TIYIN = 0n;

const TG_USERNAME_INPUT = [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }];

// Thousands are grouped with a no-break space so a label never wraps in the middle of a number.
const NBSP = ' ';

// Chip values from design/handoff/Product.dc.html (qtyChips).
const STARS_PACKS: ReadonlyArray<readonly [number, string]> = [
  [50, '50'],
  [100, '100'],
  [250, '250'],
  [500, '500'],
  [1000, `1${NBSP}000`],
  [2500, `2${NBSP}500`],
];

const PREMIUM_MONTHS: ReadonlyArray<readonly [number, string, string]> = [
  [3, '3 oylik', '3 месяца'],
  [6, '6 oylik', '6 месяцев'],
  [12, '12 oylik', '12 месяцев'],
];

export const SEED_CATEGORIES: SeedCategory[] = [
  {
    slug: 'telegram',
    nameUz: 'Telegram',
    nameRu: 'Telegram',
    sort: 1,
    products: [
      {
        slug: 'telegram-stars',
        nameUz: 'Telegram Stars',
        nameRu: 'Telegram Stars',
        descriptionUz: 'Sovg‘alar, reaksiyalar va obunalar uchun yulduzlar',
        descriptionRu: 'Звёзды для подарков, реакций и подписок',
        imageUrl: '/assets/products/telegram-stars.svg',
        regionBadge: 'GLOBAL',
        deliveryType: 'TG_USERNAME',
        inputSchema: TG_USERNAME_INPUT,
        allowCustomQty: true,
        minQty: 50,
        maxQty: 100_000,
        sort: 1,
        routes: [
          { adapter: 'FRAGMENT', priority: 1, isEnabled: true },
          // Reseller fallback is wired in a later phase; the row exists so the router order is fixed.
          { adapter: 'RESELLER_STARS', priority: 2, isEnabled: false },
        ],
        skus: STARS_PACKS.map(([quantity, text]) => ({
          quantity,
          tab: null,
          labelUz: `${text} ⭐`,
          labelRu: `${text} ⭐`,
        })),
      },
      {
        slug: 'telegram-premium',
        nameUz: 'Telegram Premium',
        nameRu: 'Telegram Premium',
        descriptionUz: 'O‘zingizga yoki do‘stingizga Premium obuna',
        descriptionRu: 'Подписка Premium для себя или друга',
        imageUrl: '/assets/products/telegram-premium.svg',
        regionBadge: 'GLOBAL',
        deliveryType: 'TG_USERNAME',
        inputSchema: TG_USERNAME_INPUT,
        allowCustomQty: false,
        minQty: null,
        maxQty: null,
        sort: 2,
        routes: [{ adapter: 'FRAGMENT', priority: 1, isEnabled: true }],
        skus: PREMIUM_MONTHS.map(([quantity, labelUz, labelRu]) => ({
          quantity,
          tab: null,
          labelUz,
          labelRu,
        })),
      },
    ],
  },
];
