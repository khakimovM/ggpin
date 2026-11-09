import type { CatalogCategory, CatalogProductListItem } from '@repo/shared';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { useCatalogSearchStore } from '../../../stores/catalog-search-store';
import { renderApp } from '../../auth/__tests__/test-utils';
import { CatalogView } from '../CatalogView';

const mocks = vi.hoisted(() => ({ getCategories: vi.fn(), getProducts: vi.fn() }));
vi.mock('../../../lib/api/catalog', () => ({
  getCategories: mocks.getCategories,
  getProducts: mocks.getProducts,
}));

const CATEGORIES: CatalogCategory[] = [
  { slug: 'telegram', name: 'Telegram', productCount: 1 },
  { slug: 'games', name: 'O‘yinlar', productCount: 2 },
];
const product = (
  slug: string,
  categorySlug: string,
  extra: Partial<CatalogProductListItem> = {},
) => ({
  id: slug,
  slug,
  categorySlug,
  name: slug.toUpperCase(),
  imageUrl: `/assets/${slug}.svg`,
  regionBadge: null,
  deliveryType: 'GAME_ID' as const,
  isAuto: true,
  isFeatured: false,
  inStock: true,
  fromPriceTiyin: '550000',
  ...extra,
});
const PRODUCTS = [product('stars', 'telegram'), product('pubg', 'games'), product('mlbb', 'games')];
const page = (items: CatalogProductListItem[]) => ({
  items,
  meta: { page: 1, limit: 100, total: items.length },
});

const href = (slug: string) => `/tg/products/${slug}`;
const view = (props: Partial<Parameters<typeof CatalogView>[0]> = {}, locale: 'uz' | 'ru' = 'uz') =>
  renderApp(
    <CatalogView
      variant="tg"
      category={undefined}
      onCategoryChange={vi.fn()}
      productHref={href}
      {...props}
    />,
    { locale },
  );

beforeEach(() => {
  mocks.getCategories.mockReset().mockResolvedValue(CATEGORIES);
  mocks.getProducts.mockReset().mockResolvedValue(page(PRODUCTS));
  useCatalogSearchStore.setState({ text: '' });
});
afterEach(() => vi.restoreAllMocks());

describe('CatalogView: the four states', () => {
  it('skeleton: a busy placeholder with a status text, until the data is there', async () => {
    let finish: (value: ReturnType<typeof page>) => void = () => undefined;
    mocks.getProducts.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    view();
    expect(screen.getByText('Mahsulotlar yuklanmoqda…')).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    finish(page(PRODUCTS));
    expect(await screen.findByRole('link', { name: /STARS/ })).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('error: the message, no products, and retry asks both requests again', async () => {
    mocks.getProducts.mockRejectedValueOnce(new ApiError({ status: 500, code: 'INTERNAL_ERROR' }));
    view();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Mahsulotlarni yuklab bo‘lmadi');
    expect(alert).toHaveTextContent('Balansingiz va buyurtmalaringiz xavfsiz.');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByRole('link', { name: /STARS/ })).toBeInTheDocument();
    expect(mocks.getProducts).toHaveBeenCalledTimes(2);
  });

  it('success (Mini App): one titled section per category, every product a link', async () => {
    view();
    await screen.findByRole('link', { name: /STARS/ });
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Telegram',
      'O‘yinlar',
    ]);
    expect(screen.getByRole('link', { name: /PUBG/ })).toHaveAttribute('href', '/tg/products/pubg');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('success (web): a heading with the count and one flat grid, no section titles', async () => {
    view({ variant: 'web' });
    await screen.findByRole('link', { name: /STARS/ });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Barcha mahsulotlar' }),
    ).toBeInTheDocument();
    expect(screen.getByText('3 ta mahsulot')).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
  });

  it('Russian: the same, in Russian, with the plural of the count', async () => {
    mocks.getCategories.mockResolvedValue([{ slug: 'games', name: 'Игры', productCount: 3 }]);
    view({ variant: 'web' }, 'ru');
    await screen.findByRole('link', { name: /STARS/ });
    expect(screen.getByRole('heading', { level: 1, name: 'Все товары' })).toBeInTheDocument();
    expect(screen.getByText('3 товара')).toBeInTheDocument();
  });
});

describe('CatalogView: the web announcements', () => {
  const premium = (extra: Partial<CatalogProductListItem> = {}) =>
    product('telegram-premium', 'telegram', extra);

  it('the Premium banner is there only for a Premium that is on sale', async () => {
    mocks.getProducts.mockResolvedValue(page([premium(), ...PRODUCTS]));
    view({ variant: 'web' });
    await screen.findByRole('link', { name: /TELEGRAM-PREMIUM/ });
    expect(screen.getByRole('button', { name: '2-eʼlon' })).toBeInTheDocument();
  });

  it('a sold-out Premium gets no banner (one announcement, no dots)', async () => {
    mocks.getProducts.mockResolvedValue(page([premium({ inStock: false }), ...PRODUCTS]));
    view({ variant: 'web' });
    await screen.findByRole('link', { name: /TELEGRAM-PREMIUM/ });
    expect(screen.getByText('Havolani olish')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2-eʼlon' })).toBeNull();
  });
});

describe('CatalogView: the banner and a filter that is still loading', () => {
  it('going from a category back to "all" while the new answer is on its way: no Premium banner from the old list', async () => {
    const premium = product('telegram-premium', 'telegram');
    mocks.getProducts.mockImplementation(({ category }: { category?: string }) =>
      category === 'telegram' ? Promise.resolve(page([premium])) : new Promise(() => undefined),
    );
    const { rerender } = view({ variant: 'web', category: 'telegram' });
    await screen.findByRole('link', { name: /TELEGRAM-PREMIUM/ });

    rerender(
      <CatalogView
        variant="web"
        category={undefined}
        onCategoryChange={vi.fn()}
        productHref={href}
      />,
    );
    // The old grid stays (dimmed, busy) while "all" loads; the banner waits for the real answer.
    await waitFor(() => expect(mocks.getProducts).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('link', { name: /TELEGRAM-PREMIUM/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2-eʼlon' })).toBeNull();
    expect(screen.getByText('Havolani olish')).toBeInTheDocument(); // the referral banner alone
  });
});

describe('CatalogView: empty states', () => {
  it('no products at all: says so and offers a retry', async () => {
    mocks.getCategories.mockResolvedValue([]);
    mocks.getProducts.mockResolvedValue(page([]));
    view();
    expect(await screen.findByText('Katalog hozircha bo‘sh')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Qayta urinish' })).toBeInTheDocument();
  });

  it('an empty category offers all products', async () => {
    mocks.getProducts.mockResolvedValue(page([]));
    const onCategoryChange = vi.fn();
    view({ category: 'games', onCategoryChange });
    expect(await screen.findByText('Bu kategoriyada mahsulot yo‘q')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Barcha mahsulotlar' }));
    expect(onCategoryChange).toHaveBeenCalledWith(undefined);
  });

  it('a search with no match quotes the text, and the button clears the search', async () => {
    useCatalogSearchStore.setState({ text: 'zzzz' });
    mocks.getProducts.mockResolvedValue(page([]));
    view();
    expect(await screen.findByText('Hech narsa topilmadi')).toBeInTheDocument();
    expect(screen.getByText(/“zzzz” bo‘yicha/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Qidiruvni tozalash' }));
    expect(useCatalogSearchStore.getState().text).toBe('');
  });
});

describe('CatalogView: what it asks the API for', () => {
  const lastParams = () => mocks.getProducts.mock.calls.at(-1)?.[0] as Record<string, unknown>;

  it('always the language, and the whole catalog in one page', async () => {
    view();
    await screen.findByRole('link', { name: /STARS/ });
    expect(lastParams()).toMatchObject({ locale: 'uz', limit: 100, page: 1 });
    expect(lastParams()).not.toHaveProperty('q');
    expect(lastParams()).not.toHaveProperty('category');
    expect(mocks.getCategories).toHaveBeenCalledWith('uz', expect.anything());
  });

  it('Russian asks in Russian', async () => {
    view({}, 'ru');
    await waitFor(() => expect(mocks.getProducts).toHaveBeenCalled());
    expect(lastParams()).toMatchObject({ locale: 'ru' });
    expect(mocks.getCategories).toHaveBeenCalledWith('ru', expect.anything());
  });

  it('a chosen category is sent', async () => {
    view({ category: 'games' });
    await waitFor(() => expect(mocks.getProducts).toHaveBeenCalled());
    expect(lastParams()).toMatchObject({ category: 'games' });
  });

  it('a search is sent trimmed and without the category, once it has settled', async () => {
    view({ category: 'games' });
    await screen.findByRole('link', { name: /PUBG/ });
    act(() => useCatalogSearchStore.setState({ text: '  pubg  ' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ q: 'pubg' }), { timeout: 2000 });
    expect(lastParams()).not.toHaveProperty('category');
    const searches = mocks.getProducts.mock.calls.filter(
      ([p]) => (p as { q?: string }).q !== undefined,
    );
    expect(searches).toHaveLength(1);
  });

  it('the category chips choose a category, and "Hammasi" none', async () => {
    const onCategoryChange = vi.fn();
    view({ onCategoryChange });
    await screen.findByRole('link', { name: /STARS/ });
    await userEvent.click(screen.getByRole('button', { name: 'O‘yinlar' }));
    expect(onCategoryChange).toHaveBeenLastCalledWith('games');
    await userEvent.click(screen.getByRole('button', { name: 'Hammasi' }));
    expect(onCategoryChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByRole('button', { name: 'Hammasi' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('CatalogView: a new filter', () => {
  const byCategory = (games: () => Promise<unknown>) =>
    mocks.getProducts.mockImplementation((params: { category?: string }) =>
      params.category === 'games'
        ? games()
        : Promise.resolve(page([PRODUCTS[0] as CatalogProductListItem])),
    );
  const withCategory = (category: string | undefined) => (
    <CatalogView variant="web" category={category} onCategoryChange={vi.fn()} productHref={href} />
  );

  it('a failing new filter shows the error, never the previous products', async () => {
    byCategory(() => Promise.reject(new ApiError({ status: 500, code: 'INTERNAL_ERROR' })));
    const { rerender } = renderApp(withCategory('telegram'));
    expect(await screen.findByRole('link', { name: /STARS/ })).toBeInTheDocument();

    rerender(withCategory('games'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Mahsulotlarni yuklab bo‘lmadi');
    expect(screen.queryByRole('link', { name: /STARS/ })).not.toBeInTheDocument();
  });

  it('while the new filter loads, the previous grid is dimmed and marked busy', async () => {
    let finish: (value: ReturnType<typeof page>) => void = () => undefined;
    byCategory(() => new Promise((resolve) => (finish = resolve as typeof finish)));
    const { rerender, container } = renderApp(withCategory('telegram'));
    await screen.findByRole('link', { name: /STARS/ });
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();

    rerender(withCategory('games'));
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(container.querySelector('[aria-busy="true"]')).toHaveClass('opacity-60');
    expect(screen.getByRole('link', { name: /STARS/ })).toBeInTheDocument();

    finish(page([PRODUCTS[1] as CatalogProductListItem]));
    expect(await screen.findByRole('link', { name: /PUBG/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /STARS/ })).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe('CatalogView: categories that cannot be loaded', () => {
  it('a small error with a retry replaces the chips; the products still show', async () => {
    mocks.getCategories.mockRejectedValueOnce(
      new ApiError({ status: 500, code: 'INTERNAL_ERROR' }),
    );
    view();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Kategoriyalarni yuklab bo‘lmadi');
    expect(await screen.findByRole('link', { name: /STARS/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hammasi' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByRole('button', { name: 'O‘yinlar' })).toBeInTheDocument();
    expect(screen.queryByText('Kategoriyalarni yuklab bo‘lmadi')).not.toBeInTheDocument();
  });
});

describe('CatalogView: offline', () => {
  it('the browser reporting no connection shows the banner above what is shown', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    view();
    expect(screen.getByText('Internet aloqasi yo‘q')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /STARS/ })).toBeInTheDocument();
  });

  it('a request that found no network shows the banner too', async () => {
    mocks.getProducts.mockRejectedValue(new ApiError({ status: 0, code: 'NETWORK' }));
    mocks.getCategories.mockRejectedValue(new ApiError({ status: 0, code: 'NETWORK' }));
    view();
    expect(await screen.findByText('Internet aloqasi yo‘q')).toBeInTheDocument();
    // Two alerts: the categories and the products each say so.
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toContain('Mahsulotlarni yuklab bo‘lmadi');
  });

  it('no banner while the connection is fine', async () => {
    view();
    await screen.findByRole('link', { name: /STARS/ });
    expect(screen.queryByText('Internet aloqasi yo‘q')).not.toBeInTheDocument();
  });
});
