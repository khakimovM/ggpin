import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { PromoCarousel } from '../PromoCarousel';

const open = (giftHref: string | null, locale: 'uz' | 'ru' = 'uz') =>
  renderApp(<PromoCarousel referralHref="/store/profile" giftHref={giftHref} />, { locale });

describe('PromoCarousel', () => {
  it('shows the referral banner first and leads to the profile', () => {
    open('/store/products/telegram-premium');
    expect(screen.getByRole('link', { name: 'Havolani olish' })).toHaveAttribute(
      'href',
      '/store/profile',
    );
    // The other slide is out of reach (aria-hidden + inert), so only one link can be tabbed to.
    expect(screen.queryByRole('link', { name: 'Sovg‘a qilish' })).toBeNull();
  });

  it('the dots move to the second slide: its link becomes reachable, the first leaves', async () => {
    const user = userEvent.setup();
    open('/store/products/telegram-premium');
    await user.click(screen.getByRole('button', { name: '2-eʼlon' }));
    expect(screen.getByRole('link', { name: 'Sovg‘a qilish' })).toHaveAttribute(
      'href',
      '/store/products/telegram-premium',
    );
    expect(screen.queryByRole('link', { name: 'Havolani olish' })).toBeNull();
    expect(screen.getByRole('button', { name: '2-eʼlon' })).toHaveAttribute('aria-current', 'true');
  });

  it('without a Premium product in the catalog there is one banner and no dots', () => {
    open(null);
    expect(screen.getByRole('link', { name: 'Havolani olish' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('never turns by itself (owner decision 2026-11-09, WCAG 2.2.2): a minute later it is still on the first slide', () => {
    vi.useFakeTimers();
    try {
      open('/store/products/telegram-premium');
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByRole('link', { name: 'Havolani olish' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Premiumni' })).toBeNull();
      expect(screen.getByRole('button', { name: '1-eʼlon' })).toHaveAttribute(
        'aria-current',
        'true',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('Uzbek gift title is written "Premiumni" (no apostrophe)', async () => {
    const user = userEvent.setup();
    open('/store/products/telegram-premium');
    await user.click(screen.getByRole('button', { name: '2-eʼlon' }));
    expect(screen.getByText(/^Premiumni do‘stingizga/)).toBeInTheDocument();
  });

  it('the role descriptions are words of the page language (uz and ru), not English', () => {
    const { container, unmount } = open('/store/products/telegram-premium');
    expect(container.querySelector('section')?.getAttribute('aria-roledescription')).toBe(
      'karusel',
    );
    expect(container.querySelector('[data-slide]')?.getAttribute('aria-roledescription')).toBe(
      'eʼlon',
    );
    unmount();
    const ru = open('/store/products/telegram-premium', 'ru');
    expect(ru.container.querySelector('section')?.getAttribute('aria-roledescription')).toBe(
      'карусель',
    );
    expect(ru.container.querySelector('[data-slide]')?.getAttribute('aria-roledescription')).toBe(
      'слайд',
    );
  });

  it('Russian text', () => {
    open('/store/products/telegram-premium', 'ru');
    expect(screen.getByRole('link', { name: 'Получить ссылку' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Объявление 2' })).toBeInTheDocument();
  });
});
