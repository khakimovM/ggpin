import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SITE_PAGES } from '../../features/site/seo/site-pages';
import { PrivateLink } from '../PrivateLink';

// next/link draws an <a> too; the mark tells a client-side link from a plain one.
vi.mock('next/link', () => ({
  default: ({ children, prefetch, ...rest }: { children: ReactNode; prefetch?: boolean }) => (
    <a data-next-link={prefetch === false ? 'no-prefetch' : 'prefetch'} {...rest}>
      {children}
    </a>
  ),
}));

describe('PrivateLink', () => {
  it.each(['/terms', '/ru/privacy', '/contacts', '/', '/ru', '/unknown', '/\\evil.example/x'])(
    'to %j (the site, or nowhere known) it is a plain <a>: a full page load',
    (href) => {
      render(
        <PrivateLink href={href} prefetch={false} className="foot">
          Oferta
        </PrivateLink>,
      );
      const link = screen.getByRole('link', { name: 'Oferta' });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveClass('foot');
      expect(link).not.toHaveAttribute('data-next-link');
      expect(link).not.toHaveAttribute('prefetch');
    },
  );

  it.each(['/store', '/ru/store/orders', '/tg', '/login'])(
    'within the private pages (%j) it is a next/link, with the prefetch it was given',
    (href) => {
      render(
        <PrivateLink href={href} prefetch={false}>
          Doʻkon
        </PrivateLink>,
      );
      const link = screen.getByRole('link', { name: 'Doʻkon' });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('data-next-link', 'no-prefetch');
    },
  );
});

const pages = SITE_PAGES.map(({ path }) => path).filter((path) => path !== '/');
/** True when a source names a marketing page: the home page or one of SITE_PAGES. */
const namesMarketing = (text: string) =>
  /\bhomePath\(/.test(text) ||
  /localizedPath\([^,()]+,\s*['"`]\/['"`]\)/.test(text) ||
  pages.some((path) => new RegExp(`['"\`]${path}['"\`#?]`).test(text));

/** Every .ts/.tsx file under `dir`, tests aside. */
function sources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...sources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe('the private pages link to the site only with a full page load', () => {
  // A next/link from the store to a marketing page would mount the tracker in the store's
  // document, and Back would bring the store back with it. Every file outside the marketing code
  // that draws a next/link or moves with the router must not name a marketing page; those links
  // go through PrivateLink (or a plain <a>), and PrivateLink also guards an href it is handed at
  // run time (the 404 page's way home).
  it('no file of the private zone with a next/link or a router names a marketing page', () => {
    const src = join(__dirname, '..', '..');
    const marketing = [join('features', 'site'), join('app', '[locale]', '(marketing)')];
    const files = [...sources(join(src, 'features')), ...sources(join(src, 'app'))].filter(
      (file) => !marketing.some((dir) => relative(src, file).startsWith(dir)),
    );
    const offenders = files
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return /from ['"]next\/link['"]|\buseRouter\b/.test(text) && namesMarketing(text);
      })
      .map((file) => relative(src, file).split(sep).join('/'));
    expect(files.length).toBeGreaterThan(100);
    expect(pages).toEqual(expect.arrayContaining(['/terms', '/privacy', '/contacts', '/faq']));
    expect(offenders).toEqual([]);
  });

  it('the guard sees the old store footer: its next/link to the offer is caught', () => {
    expect(namesMarketing("const LINKS = [{ path: '/terms' }];")).toBe(true);
    expect(namesMarketing('<Link href={homePath(locale)}>')).toBe(true);
    expect(namesMarketing("localizedPath(locale, '/')")).toBe(true);
    expect(namesMarketing("localizedPath(locale, '/store/products/telegram-stars')")).toBe(false);
  });
});
