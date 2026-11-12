import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import type { SitePage } from '../../seo/site-pages';
import { SiteFooter } from '../SiteFooter';

vi.mock('next-intl/server', async () => (await import('./intl-server-mock')).intlServerMock);
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

// The footer reads the real registry through footer-links.ts; the test swaps its content.
const registry = vi.hoisted(() => ({ pages: [] as SitePage[] }));
vi.mock('../../seo/site-pages', async (original) => {
  const real = await original<typeof import('../../seo/site-pages')>();
  return {
    ...real,
    get SITE_PAGES() {
      return registry.pages;
    },
  };
});

const page = (path: SitePage['path'], indexable = true): SitePage => ({
  path,
  indexable,
  lastModified: '2026-11-12',
  changeFrequency: 'monthly',
  priority: 0.5,
});

async function renderFooter(locale: 'uz' | 'ru', pages: SitePage[]) {
  registry.pages = pages;
  const tree = await SiteFooter({ locale });
  return render(
    <NextIntlClientProvider locale={locale} messages={{ common: MESSAGES[locale].common }}>
      {tree}
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SiteFooter', () => {
  it('lists only the pages the registry has: a column with none is left out', async () => {
    await renderFooter('uz', [page('/')]);
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).queryByRole('navigation', { name: 'Mahsulotlar' })).toBeNull();
    expect(within(footer).queryByRole('navigation', { name: 'Maʼlumot' })).toBeNull();
    expect(within(footer).queryByRole('link', { name: 'Telegram Stars' })).toBeNull();
    expect(within(footer).queryByRole('link', { name: 'Aloqa' })).toBeNull();
  });

  it('a page in the registry gets its link, in the language of the page', async () => {
    await renderFooter('ru', [
      page('/'),
      page('/telegram-stars'),
      page('/faq'),
      page('/terms', false),
    ]);
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'Telegram Stars' })).toHaveAttribute(
      'href',
      '/ru/telegram-stars',
    );
    expect(within(footer).getByRole('link', { name: 'Частые вопросы' })).toHaveAttribute(
      'href',
      '/ru/faq',
    );
    // A draft page exists (it is noindex), so it is linked.
    expect(within(footer).getByRole('link', { name: 'Публичная оферта' })).toHaveAttribute(
      'href',
      '/ru/terms',
    );
    expect(within(footer).queryByRole('link', { name: 'Telegram Premium' })).toBeNull();
    expect(within(footer).queryByRole('link', { name: 'Контакты' })).toBeNull();
  });

  it('uz links carry no prefix', async () => {
    await renderFooter('uz', [page('/'), page('/privacy')]);
    expect(screen.getByRole('link', { name: 'Maxfiylik siyosati' })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });

  it('the bot link opens in a new tab, safely, and shows the handle from configuration', async () => {
    await renderFooter('uz', [page('/')]);
    const bot = screen.getByRole('link', { name: /^@/ });
    expect(bot).toHaveAttribute('href', `https://t.me/${bot.textContent?.slice(1)}`);
    expect(bot).toHaveAttribute('target', '_blank');
    expect(bot).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('the year is the one in Uzbekistan', async () => {
    vi.useFakeTimers({ now: new Date('2025-12-31T20:00:00Z'), toFake: ['Date'] });
    await renderFooter('uz', [page('/')]);
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/© 2026 ggpin/);
  });

  it('has the language switch', async () => {
    await renderFooter('ru', [page('/')]);
    expect(screen.getByRole('group', { name: 'Язык' })).toBeInTheDocument();
  });
});
