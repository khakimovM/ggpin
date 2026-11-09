import type { LedgerItem, OrderDto, OrderStatus } from '@repo/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { getLedger } from '../../../lib/api/me';
import { listOrders } from '../../../lib/api/orders';
import { renderApp } from '../../auth/__tests__/test-utils';
import { HistoryScreen } from '../HistoryScreen';

vi.mock('../../../lib/api/orders', () => ({ listOrders: vi.fn() }));
vi.mock('../../../lib/api/me', () => ({ getLedger: vi.fn(), getWallet: vi.fn(), getMe: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/tg/history' }));

const orders = vi.mocked(listOrders);
const ledger = vi.mocked(getLedger);

const NOW = Date.now();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function order(n: number, status: OrderStatus = 'DELIVERED', overrides: Partial<OrderDto> = {}) {
  return {
    id: `order_${n}`,
    number: 1000 + n,
    status,
    productId: 'prod_stars',
    productSlug: 'telegram-stars',
    productName: 'Telegram Stars',
    skuId: null,
    quantity: 500,
    recipient: { displayName: 'Dilnoza', fields: { username: 'dilnoza_k' } },
    priceTiyin: '11000000',
    discountTiyin: '0',
    totalTiyin: '11000000',
    currency: 'UZS',
    createdAt: minutesAgo(n),
    deliveredAt: null,
    ...overrides,
  } satisfies OrderDto;
}
const page = (items: OrderDto[], p = 1, total = items.length) => ({
  items,
  meta: { page: p, limit: 20, total },
});

function entry(n: number, kind: LedgerItem['kind'], amountTiyin: string, orderId: string | null) {
  return {
    id: `ledger_${n}`,
    kind,
    amountTiyin,
    createdAt: minutesAgo(n),
    orderId,
    paymentId: null,
  } satisfies LedgerItem;
}

// The tab bar has links of its own; the rows are the links inside the panel.
const panel = () => within(screen.getByRole('tabpanel'));
const rows = () => panel().queryAllByRole('link');
const findRows = () => waitFor(() => expect(rows().length).toBeGreaterThan(0)).then(rows);
const findRow = async () => (await findRows())[0] as HTMLElement;

beforeEach(() => {
  orders.mockReset();
  ledger.mockReset();
});

describe('HistoryScreen (Mini App)', () => {
  it('skeleton: a busy placeholder with a status text, while the first page loads', () => {
    orders.mockReturnValue(new Promise(() => undefined));
    const { container } = renderApp(<HistoryScreen variant="tg" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Tarix yuklanmoqda…');
    expect(screen.getByRole('heading', { level: 1, name: 'Tarix' })).toBeInTheDocument();
  });

  it('success: rows under "Bugun" with the product, the recipient, the status and a link', async () => {
    orders.mockResolvedValue(page([order(2), order(3, 'PROCESSING')]));
    renderApp(<HistoryScreen variant="tg" />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Bugun' })).toBeInTheDocument();
    const links = rows();
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/tg/orders/order_2');
    expect(links[0]).toHaveTextContent('500 ⭐');
    expect(links[0]).toHaveTextContent('@dilnoza_k · #1002');
    expect(links[0]).toHaveTextContent('Yetkazildi');
    expect(links[1]).toHaveTextContent('Bajarilmoqda');
    expect(links[0]).toHaveTextContent(/110.000.so‘m/);
    expect(orders).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 20, status: undefined, locale: 'uz' }),
      expect.anything(),
    );
  });

  it('error: a message with "Qayta urinish" that asks again', async () => {
    orders.mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    orders.mockResolvedValue(page([order(2)]));
    renderApp(<HistoryScreen variant="tg" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Tarixni yuklab bo‘lmadi');
    await userEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await findRow()).toHaveTextContent('500 ⭐');
    expect(orders).toHaveBeenCalledTimes(2);
  });

  it('empty: says so and leads to the shop; an empty filter has no such button', async () => {
    orders.mockResolvedValue(page([]));
    renderApp(<HistoryScreen variant="tg" />);
    expect(await screen.findByText('Hali buyurtmalar yo‘q')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Xaridni boshlash' })).toHaveAttribute('href', '/tg');

    await userEvent.click(screen.getByRole('button', { name: 'Kutilmoqda' }));
    expect(await screen.findByText('Bu filtrda buyurtma yo‘q')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Xaridni boshlash' })).toBeNull();
  });

  it('a filter chip asks the API for its group of statuses, in one request', async () => {
    orders.mockResolvedValue(page([order(2)]));
    renderApp(<HistoryScreen variant="tg" />);
    await findRow();
    await userEvent.click(screen.getByRole('button', { name: 'Bekor qilingan' }));
    await waitFor(() =>
      expect(orders.mock.lastCall?.[0]?.status).toEqual(['FAILED', 'CANCELLED', 'REFUNDED']),
    );
    expect(screen.getByRole('button', { name: 'Bekor qilingan' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('"Yana yuklash" appends the next page, 20 at a time', async () => {
    orders.mockImplementation((params) =>
      Promise.resolve(
        params?.page === 2
          ? page([order(30)], 2, 21)
          : page(
              Array.from({ length: 20 }, (_, i) => order(i + 2)),
              1,
              21,
            ),
      ),
    );
    renderApp(<HistoryScreen variant="tg" />);
    await findRows();
    expect(rows()).toHaveLength(20);
    await userEvent.click(screen.getByRole('button', { name: 'Yana yuklash' }));
    await waitFor(() => expect(rows()).toHaveLength(21));
    expect(orders).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2, limit: 20 }),
      expect.anything(),
    );
    expect(screen.queryByRole('button', { name: 'Yana yuklash' })).toBeNull();
  });

  it('"Moliya": money in is green with a plus, a purchase has a minus, only an order entry links', async () => {
    orders.mockResolvedValue(page([order(2)]));
    ledger.mockResolvedValue({
      items: [
        entry(1, 'PURCHASE', '-11000000', 'order_2'),
        entry(2, 'TOPUP', '5034700', null),
        entry(3, 'REFUND', '12075000', 'order_9'),
      ],
      meta: { page: 1, limit: 20, total: 3 },
    });
    renderApp(<HistoryScreen variant="tg" />);
    await userEvent.click(screen.getByRole('tab', { name: 'Moliya' }));
    expect(await screen.findByText('Xarid')).toBeInTheDocument();
    const purchase = screen.getByText(/110.000/);
    const topup = screen.getByText(/50.347/);
    expect(purchase).toHaveTextContent(/^−110.000.so‘m$/);
    expect(topup).toHaveTextContent(/^\+50.347.so‘m$/);
    expect(topup.className).toContain('text-success-text');
    expect(purchase.className).not.toContain('text-success-text');
    const links = rows();
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/tg/orders/order_2',
      '/tg/orders/order_9',
    ]);
    expect(screen.getByText('Balans to‘ldirildi').closest('a')).toBeNull();
  });

  it('"Moliya" empty and error states', async () => {
    orders.mockResolvedValue(page([order(2)]));
    ledger.mockResolvedValue({ items: [], meta: { page: 1, limit: 20, total: 0 } });
    renderApp(<HistoryScreen variant="tg" />);
    await userEvent.click(screen.getByRole('tab', { name: 'Moliya' }));
    expect(await screen.findByText('Hali amallar yo‘q')).toBeInTheDocument();
  });

  it('is a tablist: the selected tab is named, arrow keys move it', async () => {
    orders.mockResolvedValue(page([order(2)]));
    ledger.mockResolvedValue({ items: [], meta: { page: 1, limit: 20, total: 0 } });
    renderApp(<HistoryScreen variant="tg" />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    tabs[0]?.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Moliya' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      screen.getByRole('tab', { name: 'Moliya' }).id,
    );
  });

  it('Russian: the chip, the status and the empty text are in Russian', async () => {
    orders.mockResolvedValue(page([order(2, 'FAILED')]));
    renderApp(<HistoryScreen variant="tg" />, { locale: 'ru' });
    expect(await findRow()).toHaveTextContent('Не выполнен');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Сегодня');
  });
});

describe('HistoryScreen (web)', () => {
  it('a numbered pager from the server meta; a page button asks for that page', async () => {
    orders.mockImplementation((params) =>
      Promise.resolve(
        page(
          Array.from({ length: params?.page === 2 ? 5 : 20 }, (_, i) => order(i + 2)),
          params?.page ?? 1,
          25,
        ),
      ),
    );
    renderApp(<HistoryScreen variant="web" />);
    await findRows();
    const pager = screen.getByRole('navigation', { name: 'Sahifalar' });
    expect(within(pager).getByText('Jami 25 tadan 1–20')).toBeInTheDocument();
    expect(within(pager).getByRole('button', { name: 'Oldingi' })).toBeDisabled();
    await userEvent.click(within(pager).getByRole('button', { name: '2-sahifa' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'Sahifalar' })).getByText(
          'Jami 25 tadan 21–25',
        ),
      ).toBeInTheDocument(),
    );
    expect(orders).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2, limit: 20 }),
      expect.anything(),
    );
    expect(screen.getByRole('link', { name: /#1002/ }).getAttribute('href')).toBe(
      '/store/orders/order_2',
    );
  });
});
