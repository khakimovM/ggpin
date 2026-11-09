import type { OrderDetail, OrderStatus } from '@repo/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { renderApp } from '../../auth/__tests__/test-utils';
import { OrderScreen } from '../OrderScreen';
import { claimBurst } from '../SuccessBurst';

const getOrder = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api/orders', () => ({ getOrder }));

const base = (status: OrderStatus, extra: Partial<OrderDetail> = {}): OrderDetail => ({
  id: 'o1',
  number: 1042,
  status,
  productId: 'p1',
  productSlug: 'telegram-stars',
  productName: 'Telegram Stars',
  skuId: null,
  quantity: 500,
  recipient: { displayName: 'Dilnoza K.', fields: { username: 'dilnoza_k' } },
  priceTiyin: '11000000',
  discountTiyin: '0',
  totalTiyin: '11000000',
  currency: 'UZS',
  createdAt: '2026-11-08T10:02:00.000Z',
  deliveredAt: null,
  timeline: [{ status: 'PAID', at: '2026-11-08T10:02:00.000Z' }],
  voucher: null,
  ...extra,
});

const open = (locale: 'uz' | 'ru' = 'uz') =>
  renderApp(<OrderScreen variant="web" id="o1" />, { locale });

beforeEach(() => {
  getOrder.mockReset();
  window.sessionStorage.clear();
});

describe('the four states', () => {
  it('loading: a skeleton with a status text', () => {
    getOrder.mockReturnValue(new Promise(() => undefined));
    open();
    expect(screen.getByRole('status')).toHaveTextContent('Buyurtma yuklanmoqda');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('error: a message and a retry that loads the order', async () => {
    getOrder.mockRejectedValueOnce(new ApiError({ status: 0, code: 'NETWORK' }));
    getOrder.mockResolvedValue(base('PROCESSING'));
    const user = userEvent.setup();
    open();
    expect(await screen.findByText('Buyurtmani yuklab bo‘lmadi')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Qayta urinish' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Bajarilmoqda' })).toBeVisible();
  });

  it('not found (an order of somebody else looks the same): a way home', async () => {
    getOrder.mockRejectedValue(new ApiError({ status: 404, code: 'NOT_FOUND' }));
    open();
    expect(await screen.findByText('Buyurtma topilmadi')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bosh sahifaga' })).toHaveAttribute('href', '/store');
  });

  it('ready: the order', async () => {
    getOrder.mockResolvedValue(base('PROCESSING'));
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Bajarilmoqda' })).toBeVisible();
  });
});

describe('what each status says', () => {
  it('in progress: who gets what, the steps, the amount, and that closing the app is fine', async () => {
    getOrder.mockResolvedValue(
      base('PROCESSING', {
        timeline: [
          { status: 'PAID', at: '2026-11-08T10:02:00.000Z' },
          { status: 'QUEUED', at: '2026-11-08T10:02:01.000Z' },
          { status: 'PROCESSING', at: '2026-11-08T10:02:05.000Z' },
        ],
      }),
    );
    open();
    expect(await screen.findByText(/@dilnoza_k hisobiga 500 ⭐ yuborilmoqda/)).toBeInTheDocument();
    expect(screen.getByText(/Buyurtma #1042 · /)).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'Buyurtma holati' })).getAllByRole(
      'listitem',
    );
    expect(steps.map((step) => step.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'active',
      'pending',
    ]);
    expect(document.body).toHaveTextContent(/110.000\s*so‘m/);
    expect(screen.getByText(/Sahifani yopsangiz ham buyurtma davom etadi/)).toBeInTheDocument();
    expect(screen.queryByText('Qaytarildi')).toBeNull();
  });

  it('delivered: "Yetkazildi!", a way to buy again, the burst claimed once', async () => {
    getOrder.mockResolvedValue(base('DELIVERED', { deliveredAt: '2026-11-08T10:03:00.000Z' }));
    open();
    expect(await screen.findByRole('heading', { level: 1, name: /Yetkazildi!/ })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Yana xarid qilish' })).toHaveAttribute(
      'href',
      '/store/products/telegram-stars',
    );
    await waitFor(() => expect(window.sessionStorage.getItem('ggpin:burst:o1')).toBe('1'));
    // The flag holds nothing but "1": no amount, no name.
    expect(claimBurst('o1')).toBe(false);
    expect(claimBurst('another')).toBe(true);
  });

  it('under review: reassures, offers the way home', async () => {
    getOrder.mockResolvedValue(base('NEEDS_REVIEW'));
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Tekshirilmoqda' })).toBeVisible();
    expect(screen.getByText(/Pulingiz xavfsiz/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bosh sahifaga' })).toBeInTheDocument();
  });

  it('failed: the money is back, shown as the server wrote it, with a try-again to the product', async () => {
    getOrder.mockResolvedValue(
      base('FAILED', {
        timeline: [
          { status: 'PAID', at: '2026-11-08T10:02:00.000Z' },
          { status: 'FAILED', at: '2026-11-08T10:03:00.000Z' },
        ],
      }),
    );
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Bajarilmadi' })).toBeVisible();
    expect(screen.getByText(/110.000\s*so‘m balansingizga qaytarildi/)).toBeInTheDocument();
    expect(screen.getByText('Qaytarildi')).toBeInTheDocument();
    expect(screen.getByText(/^\+/)).toHaveTextContent(/\+\s*110.000\s*so‘m/);
    expect(screen.getByRole('link', { name: 'Qayta urinish' })).toHaveAttribute(
      'href',
      '/store/products/telegram-stars',
    );
  });

  it('refunded by an admin: the money is back, but no amount is promised (it may be partial)', async () => {
    getOrder.mockResolvedValue(
      base('REFUNDED', {
        timeline: [
          { status: 'PAID', at: '2026-11-08T10:02:00.000Z' },
          { status: 'DELIVERED', at: '2026-11-08T10:03:00.000Z' },
          { status: 'REFUNDED', at: '2026-11-08T10:30:00.000Z' },
        ],
      }),
    );
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Pul qaytarildi' })).toBeVisible();
    // the order's own total (110 000) is shown once, as the amount paid; no "+110 000" and no
    // "110 000 balansingizga qaytarildi"
    expect(screen.queryByText(/110.000\s*so‘m balansingizga/)).toBeNull();
    expect(screen.queryByText(/^\+/)).toBeNull();
    expect(document.body.textContent?.match(/110.000\s*so‘m/g)).toHaveLength(1);
    expect(screen.getByText('Qaytarildi')).toBeInTheDocument();
  });

  it('cancelled', async () => {
    getOrder.mockResolvedValue(base('CANCELLED'));
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Bekor qilindi' })).toBeVisible();
  });

  it('in Russian, with the plural of months for Premium', async () => {
    getOrder.mockResolvedValue(
      base('PROCESSING', {
        productSlug: 'telegram-premium',
        productName: 'Telegram Premium',
        quantity: 3,
      }),
    );
    open('ru');
    expect(
      await screen.findByText(/На аккаунт @dilnoza_k отправляется Premium: 3 месяца/),
    ).toBeInTheDocument();
    // the web has no bot message to promise: the note talks about the page only
    expect(screen.getByText('Если закроете страницу, заказ продолжится')).toBeInTheDocument();
    expect(screen.queryByText(/бот/)).toBeNull();
  });
});

describe('the code of a voucher', () => {
  const VOUCHER = { code: 'XK7Q-92LM-PA3D-8R2T' };

  it('is shown as text, can be copied, and says so', async () => {
    getOrder.mockResolvedValue(base('DELIVERED', { voucher: VOUCHER }));
    const user = userEvent.setup();
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Kod tayyor!' })).toBeVisible();
    expect(screen.getByText(VOUCHER.code)).toBeInTheDocument();
    expect(screen.getByText('Kodni hech kimga ko‘rsatmang')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Nusxalash' }));
    expect(await screen.findByText('Nusxalandi')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(VOUCHER.code);
  });

  it('never becomes markup, whatever the code contains', async () => {
    const hostile = '<img src=x onerror="window.__xss=1"><b>X</b>';
    getOrder.mockResolvedValue(base('DELIVERED', { voucher: { code: hostile } }));
    open();
    expect(await screen.findByText(hostile)).toBeInTheDocument();
    const block = screen.getByTestId('voucher-code');
    expect(block.querySelector('img, b')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('is only on delivered orders that have one', async () => {
    getOrder.mockResolvedValue(base('DELIVERED'));
    open();
    await screen.findByRole('heading', { level: 1, name: /Yetkazildi!/ });
    expect(screen.queryByTestId('voucher-code')).toBeNull();
  });
});

describe('the web page from 768 px', () => {
  const wide = () =>
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(min-width: 768px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));

  it('puts the product and the buttons in a "details" panel and adds a breadcrumb to the history', async () => {
    wide();
    try {
      getOrder.mockResolvedValue(base('DELIVERED'));
      open();
      expect(
        await screen.findByRole('heading', { level: 2, name: 'Buyurtma tafsilotlari' }),
      ).toBeVisible();
      const crumb = screen.getByRole('navigation', { name: 'Sahifa yo‘li' });
      expect(within(crumb).getByRole('link', { name: 'Tarix' })).toHaveAttribute(
        'href',
        '/store/orders',
      );
      expect(crumb).toHaveTextContent('Buyurtma #1042');
      // Each block once: the buttons are in the panel only.
      expect(screen.getAllByRole('link', { name: 'Yana xarid qilish' })).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('crossing 768 px does not remount the status (the same DOM node, so the hero keeps its state)', async () => {
    let wideNow = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return query === '(min-width: 768px)' && wideNow;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }));
    try {
      getOrder.mockResolvedValue(base('PROCESSING'));
      const { container } = open();
      await screen.findByRole('heading', { level: 1, name: 'Bajarilmoqda' });
      const before = container.querySelector('[data-hero]');
      expect(before).not.toBeNull();
      expect(screen.queryByRole('heading', { level: 2, name: 'Buyurtma tafsilotlari' })).toBeNull();

      wideNow = true;
      act(() => listeners.forEach((listener) => listener()));
      expect(
        await screen.findByRole('heading', { level: 2, name: 'Buyurtma tafsilotlari' }),
      ).toBeVisible();
      expect(container.querySelector('[data-hero]')).toBe(before);

      wideNow = false;
      act(() => listeners.forEach((listener) => listener()));
      await waitFor(() =>
        expect(
          screen.queryByRole('heading', { level: 2, name: 'Buyurtma tafsilotlari' }),
        ).toBeNull(),
      );
      expect(container.querySelector('[data-hero]')).toBe(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a phone keeps the single column: no panel, no breadcrumb', async () => {
    getOrder.mockResolvedValue(base('PROCESSING'));
    open();
    await screen.findByRole('heading', { level: 1, name: 'Bajarilmoqda' });
    expect(screen.queryByRole('heading', { level: 2, name: 'Buyurtma tafsilotlari' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Sahifa yo‘li' })).toBeNull();
  });
});
