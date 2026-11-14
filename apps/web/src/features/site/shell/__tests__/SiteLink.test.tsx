import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { leavesMarketing, SiteLink } from '../SiteLink';

// next/link draws an <a> too; the mark tells a client-side link from a plain one.
vi.mock('next/link', () => ({
  default: ({ children, prefetch, ...rest }: { children: ReactNode; prefetch?: boolean }) => (
    <a data-next-link={prefetch === false ? 'no-prefetch' : 'prefetch'} {...rest}>
      {children}
    </a>
  ),
}));

describe('leavesMarketing', () => {
  it.each(['/', '/faq', '/ru', '/ru/faq', '/#products', '/ru#faq', '/telegram-stars', '/terms'])(
    'stays on the marketing pages: %j',
    (href) => {
      expect(leavesMarketing(href)).toBe(false);
    },
  );

  it.each([
    '/store',
    '/ru/store',
    '/store/products/telegram-stars',
    '/ru/store/products/pubg-mobile',
    '/login',
    '/ru/login',
    '/tg',
    '/pay/cm3intent',
    '/faq/',
    '/unknown',
    'https://t.me/ggpin_bot',
    '//evil.example/faq',
    // A browser reads a backslash after the first slash as a slash: another host.
    '/\\evil.example/faq',
    '/\\/evil.example/faq',
    '\\evil',
    '\\\\evil',
    'faq',
    '',
  ])('leaves them (a full page load): %j', (href) => {
    expect(leavesMarketing(href)).toBe(true);
  });
});

describe('SiteLink', () => {
  it.each(['/store', '/ru/store', '/ru/login', '/store/products/telegram-stars'])(
    'into %j it is a plain <a> with the href as given, and keeps the look and the name',
    (href) => {
      render(
        <SiteLink href={href} prefetch={false} className="cta" aria-label="Doʻkon">
          Doʻkon
        </SiteLink>,
      );
      const link = screen.getByRole('link', { name: 'Doʻkon' });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveClass('cta');
      expect(link).not.toHaveAttribute('data-next-link');
      expect(link).not.toHaveAttribute('prefetch');
    },
  );

  it('between marketing pages it is a next/link, with the prefetch it was given', () => {
    render(
      <SiteLink href="/ru/faq" prefetch={false} className="nav">
        FAQ
      </SiteLink>,
    );
    const link = screen.getByRole('link', { name: 'FAQ' });
    expect(link).toHaveAttribute('href', '/ru/faq');
    expect(link).toHaveAttribute('data-next-link', 'no-prefetch');
    expect(link).toHaveClass('nav');
  });
});

describe('the marketing pages link only through SiteLink', () => {
  // A next/link into the store from a marketing page would carry the analytics tracker along.
  // PrivateLink makes a client-side move into the private zone, which a marketing page must not.
  it('no file of features/site imports next/link but SiteLink, nor PrivateLink', () => {
    const root = join(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(path);
        } else if (/\.tsx?$/.test(entry.name)) files.push(path);
      }
    };
    walk(root);
    const offenders = files
      .filter((file) =>
        /from ['"](next\/link|[./]+\/lib\/PrivateLink)['"]/.test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(root, file).split(sep).join('/'));
    expect(files.length).toBeGreaterThan(20);
    expect(offenders).toEqual(['shell/SiteLink.tsx']);
  });
});
