// The product detail the fake of e2e/fixtures/product.ts answers with, shaped like docs/04: Telegram
// Stars (packages and a free quantity) and Telegram Premium (3, 6 and 12 month terms).

export type Lang = 'uz' | 'ru';
export type ProductMode = 'ok' | 'error' | 'drop' | 'slow' | 'missing' | 'soldOut' | 'unsupported';

/** Tiyin per star: 220 so'm. */
export const STAR_TIYIN = 22_000n;
export const PREMIUM_PRICE: Record<string, string> = {
  m3: '16500000',
  m6: '22000000',
  m12: '39600000',
};

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
export const MONTHS: Record<Lang, [string, number, string][]> = {
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

export function detail(slug: string, lang: Lang, mode: ProductMode, options: { help?: boolean }) {
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
