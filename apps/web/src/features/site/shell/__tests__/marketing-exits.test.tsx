import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../../../../i18n/messages';
import { FinalCta } from '../../landing/FinalCta';
import { Hero } from '../../landing/Hero';
import { ProductsSection } from '../../landing/ProductsSection';
import { settleServerTree } from '../../landing/__tests__/render-server';
import { PackagePicker } from '../../product/PackagePicker';
import { BuyLink } from '../../product/ProductButtons';
import { SiteHeader } from '../SiteHeader';

// Phase 8 S5 (audit M2): every way from a marketing page into the store or the login is a plain
// <a> (a full page load, so the analytics tracker stays behind), in the visitor's language.

vi.mock('next-intl/server', async () => (await import('./intl-server-mock')).intlServerMock);
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
// The grid waits for the catalog; only the section's own link matters here.
vi.mock('../../landing/ProductsGrid', () => ({ ProductsGrid: () => null }));
vi.mock('next/link', () => ({
  default: ({
    children,
    prefetch: _prefetch,
    ...rest
  }: {
    children: ReactNode;
    prefetch?: boolean;
  }) => (
    <a data-next-link="" {...rest}>
      {children}
    </a>
  ),
}));

const prefix = (locale: 'uz' | 'ru') => (locale === 'uz' ? '' : '/ru');

function expectFullLoad(link: HTMLElement, href: string) {
  expect(link.tagName).toBe('A');
  expect(link).toHaveAttribute('href', href);
  expect(link).not.toHaveAttribute('data-next-link');
}

describe.each(['uz', 'ru'] as const)('leaving the marketing pages (%s)', (locale) => {
  const site = MESSAGES[locale].site;
  const store = `${prefix(locale)}/store`;

  it('the hero, the products section and the final call lead into the store with a full load', async () => {
    render(
      await settleServerTree(
        <>
          {await Hero({ locale })}
          {await ProductsSection({ locale })}
          {await FinalCta({ locale })}
        </>,
      ),
    );
    const storeLinks = screen.getAllByRole('link', { name: new RegExp(site.cta.store) });
    expect(storeLinks).toHaveLength(2);
    for (const link of storeLinks) expectFullLoad(link, store);
    expectFullLoad(screen.getByRole('link', { name: site.products.all }), store);
  });

  it('the header and its menu lead to the login with a full load; the sections stay client-side', async () => {
    const tree = await SiteHeader({ locale });
    render(
      <NextIntlClientProvider locale={locale} messages={{ common: MESSAGES[locale].common }}>
        {tree}
      </NextIntlClientProvider>,
    );
    const logins = screen.getAllByRole('link', { name: site.nav.login });
    expect(logins).toHaveLength(2);
    for (const link of logins) expectFullLoad(link, `${prefix(locale)}/login`);
    const products = screen.getAllByRole('link', { name: site.nav.products })[0];
    expect(products).toHaveAttribute('data-next-link');
  });

  it("a product page's buy buttons lead into the store with a full load", () => {
    const href = `${store}/products/telegram-stars`;
    render(
      <>
        <BuyLink href={href} label="buy-link" />
        <PackagePicker
          label="Stars"
          amountHeading="amount"
          priceHeading="price"
          options={[{ id: 'p1', label: '50 ⭐', price: null, cta: 'buy-picker' }]}
          notes={[]}
          buyHref={href}
        />
      </>,
    );
    expectFullLoad(screen.getByRole('link', { name: 'buy-link' }), href);
    expectFullLoad(screen.getByRole('link', { name: 'buy-picker' }), href);
  });
});
