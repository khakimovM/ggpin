import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import { SiteHeader } from '../SiteHeader';

vi.mock('next-intl/server', async () => (await import('./intl-server-mock')).intlServerMock);
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

async function renderHeader(locale: 'uz' | 'ru') {
  const tree = await SiteHeader({ locale });
  return render(
    <NextIntlClientProvider locale={locale} messages={{ common: MESSAGES[locale].common }}>
      {tree}
    </NextIntlClientProvider>,
  );
}

const hrefsOf = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href'));

describe('SiteHeader', () => {
  it('the logo leads home and is named with the brand', async () => {
    await renderHeader('uz');
    expect(screen.getByRole('link', { name: 'ggpin — bosh sahifa' })).toHaveAttribute('href', '/');
  });

  it('the sections are anchors on the landing', async () => {
    await renderHeader('uz');
    expect(hrefsOf(screen.getByRole('navigation', { name: 'Asosiy' }))).toEqual([
      '/#products',
      '/#how-it-works',
      '/#faq',
    ]);
  });

  it('from the Russian pages the sections point at the Russian landing', async () => {
    await renderHeader('ru');
    const nav = screen.getByRole('navigation', { name: 'Основное' });
    expect(hrefsOf(nav)).toEqual(['/ru#products', '/ru#how-it-works', '/ru#faq']);
    expect(within(nav).getByRole('link', { name: 'Как это работает' })).toBeInTheDocument();
  });

  it('sign-in leads to the login page of the same language', async () => {
    await renderHeader('ru');
    const links = screen.getAllByRole('link', { name: 'Войти' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute('href', '/ru/login');
  });

  it('"Open in Telegram" is an external link that opens safely', async () => {
    await renderHeader('uz');
    const links = screen.getAllByRole('link', { name: 'Telegramʼda ochish' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/^https:\/\/t\.me\/\w+$/);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('has the menu button, closed', async () => {
    await renderHeader('ru');
    expect(screen.getByRole('button', { name: 'Меню' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('collapses at a different width in each language', async () => {
    const uz = await renderHeader('uz');
    expect(uz.container.innerHTML).toContain('min-[1041px]:flex');
    expect(uz.container.innerHTML).not.toContain('min-[1181px]');
    uz.unmount();
    const ru = await renderHeader('ru');
    expect(ru.container.innerHTML).toContain('min-[1181px]:flex');
    expect(ru.container.innerHTML).not.toContain('min-[1041px]');
  });
});
