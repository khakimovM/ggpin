import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import { SiteLangSwitch } from '../SiteLangSwitch';

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const LABELS = { group: 'Til', names: { uz: 'O‘zbekcha', ru: 'Русский' } };

function renderSwitch(locale: 'uz' | 'ru', pathname: string) {
  nav.pathname = pathname;
  return render(
    <NextIntlClientProvider locale={locale} messages={{ common: MESSAGES[locale].common }}>
      <SiteLangSwitch labels={LABELS} />
    </NextIntlClientProvider>,
  );
}

const hrefs = () => ({
  uz: screen.getByRole('link', { name: /O‘zbekcha/ }).getAttribute('href'),
  ru: screen.getByRole('link', { name: /Русский/ }).getAttribute('href'),
});

describe('SiteLangSwitch', () => {
  it.each([
    ['uz', '/', { uz: '/', ru: '/ru' }],
    ['ru', '/ru', { uz: '/', ru: '/ru' }],
    ['uz', '/telegram-stars', { uz: '/telegram-stars', ru: '/ru/telegram-stars' }],
    ['ru', '/ru/telegram-stars', { uz: '/telegram-stars', ru: '/ru/telegram-stars' }],
    ['ru', '/ru/faq', { uz: '/faq', ru: '/ru/faq' }],
  ] as const)('%s on %s keeps the page and changes the language', (locale, pathname, expected) => {
    renderSwitch(locale, pathname);
    expect(hrefs()).toEqual(expected);
  });

  it('marks the current language and only it', () => {
    renderSwitch('ru', '/ru');
    expect(screen.getByRole('link', { name: /Русский/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: /O‘zbekcha/ })).not.toHaveAttribute('aria-current');
  });

  it('every link says its language (hreflang and lang) and shows its code', () => {
    renderSwitch('uz', '/');
    const uz = screen.getByRole('link', { name: /O‘zbekcha/ });
    const ru = screen.getByRole('link', { name: /Русский/ });
    expect(uz).toHaveAttribute('hreflang', 'uz');
    expect(uz).toHaveAttribute('lang', 'uz');
    expect(uz).toHaveTextContent('UZ');
    expect(ru).toHaveAttribute('hreflang', 'ru');
    expect(ru).toHaveTextContent('RU');
  });

  it('is a named group', () => {
    renderSwitch('uz', '/');
    expect(screen.getByRole('group', { name: 'Til' })).toBeInTheDocument();
  });
});
