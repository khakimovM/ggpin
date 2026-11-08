import type { CatalogProductDetail, QuoteResponse, ValidateRecipientResponse } from '@repo/shared';
import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { expect } from 'vitest';
import { useProductUiStore } from '../../../stores/product-ui-store';
import { renderApp } from '../../auth/__tests__/test-utils';
import { ProductScreen } from '../ProductScreen';

// Shared by ProductScreen.test.tsx and ProductScreen.price.test.tsx. The vi.mock calls cannot live
// here (they must be in each test file), so each file declares its own and passes its mocks in.

export const TOKEN = 'R'.repeat(43);
const sku = (id: string, quantity: number, label: string, price: string) => ({
  id,
  label,
  quantity,
  tab: null,
  fromPriceTiyin: price,
});

export const STARS: CatalogProductDetail = {
  id: 'p_stars',
  slug: 'telegram-stars',
  name: 'Telegram Stars',
  description: 'Sovg‘alar uchun yulduzlar',
  help: null,
  imageUrl: '/assets/products/telegram-stars.svg',
  deliveryType: 'TG_USERNAME',
  regionBadge: 'GLOBAL',
  isAuto: true,
  allowCustomQty: true,
  minQty: 50,
  maxQty: 100_000,
  inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
  skus: [sku('s50', 50, '50 ⭐', '1100000'), sku('s100', 100, '100 ⭐', '2200000')],
  unitPriceTiyin: '22000',
  stock: null,
  currency: 'UZS',
};
export const PREMIUM: CatalogProductDetail = {
  ...STARS,
  id: 'p_premium',
  slug: 'telegram-premium',
  name: 'Telegram Premium',
  allowCustomQty: false,
  minQty: null,
  maxQty: null,
  skus: [
    sku('m3', 3, '3 oylik', '16500000'),
    sku('m6', 6, '6 oylik', '22000000'),
    sku('m12', 12, '12 oylik', '39600000'),
  ],
  unitPriceTiyin: null,
};

export const FOUND: ValidateRecipientResponse = {
  recipientToken: TOKEN,
  displayName: 'Aziz',
  warnings: [],
};
export const quote = (total: string): QuoteResponse => ({
  quoteId: `q_${total}`,
  priceTiyin: total,
  discountTiyin: '0',
  totalTiyin: total,
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  recipient: { username: 'aziz_k', displayName: 'Aziz' },
  currency: 'UZS',
});

export const open = (slug = 'telegram-stars', locale: 'uz' | 'ru' = 'uz') =>
  renderApp(<ProductScreen variant="web" slug={slug} />, { locale });

// The bottom bar and the sticky-panel button are both in the DOM (CSS hides one of them).
export const buyButtons = () =>
  screen.getAllByRole('button', {
    name: /^(Sotib olish|Avval qabul|Paketni tanlang|Narx eskirdi|Narx tayyor|Narx hozircha|Bu foydalanuvchiga|Купить|Сначала)/,
  });
export const expectBuy = (enabled: boolean) => {
  for (const button of buyButtons()) {
    if (enabled) expect(button).toBeEnabled();
    else expect(button).toBeDisabled();
  }
};

export async function confirmRecipient(user: ReturnType<typeof userEvent.setup>, name = 'aziz_k') {
  await user.type(await screen.findByRole('textbox', { name: /username/i }), name);
  await user.click(screen.getByRole('button', { name: 'Tekshirish' }));
  await user.click(await screen.findByRole('button', { name: 'Ha, shu' }));
}

/** The API doubles every file mocks, with the answers of a normal day. */
export interface ApiDoubles {
  getProduct: { mockReset: () => void; mockResolvedValue: (value: unknown) => void };
  validateRecipient: { mockReset: () => void; mockResolvedValue: (value: unknown) => void };
  createQuote: { mockReset: () => void; mockResolvedValue: (value: unknown) => void };
  getMe: { mockReset: () => void; mockResolvedValue: (value: unknown) => void };
  getWallet: { mockReset: () => void; mockResolvedValue: (value: unknown) => void };
}

export function resetApi(api: ApiDoubles): void {
  api.getProduct.mockReset();
  api.validateRecipient.mockReset();
  api.createQuote.mockReset();
  api.getMe.mockReset();
  api.getWallet.mockReset();
  useProductUiStore.getState().reset();
  api.getProduct.mockResolvedValue(STARS);
  api.validateRecipient.mockResolvedValue(FOUND);
  api.createQuote.mockResolvedValue(quote('550000'));
  api.getMe.mockResolvedValue({ username: 'sardor_r' });
  api.getWallet.mockResolvedValue({ balanceTiyin: '8540000', coins: '0', currency: 'UZS' });
}
