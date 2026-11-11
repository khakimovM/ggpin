import { BRAND } from '@repo/shared';
import { ThemeProvider } from '@repo/ui';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../auth/__tests__/test-utils';
import { LoginShell } from '../../auth/LoginShell';
import { StoreHeader } from '../StoreHeader';

const nav = vi.hoisted(() => ({ getMe: vi.fn(), getWallet: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/store',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('../../../lib/api/me', () => ({ getMe: nav.getMe, getWallet: nav.getWallet }));

beforeEach(() => {
  nav.getMe.mockReset().mockRejectedValue(new Error('not needed'));
  nav.getWallet.mockReset().mockRejectedValue(new Error('not needed'));
});

/**
 * What a sighted user reads inside a node: text that is not aria-hidden, and the label of an image
 * (the wordmark is an `img` whose label is the same word). Roughly what axe's
 * `label-content-name-mismatch` compares against the link's name.
 */
function visibleText(node: Node): string {
  if (node instanceof Text) return node.data;
  if (!(node instanceof HTMLElement) || node.getAttribute('aria-hidden') === 'true') return '';
  if (node.getAttribute('role') === 'img') return node.getAttribute('aria-label') ?? '';
  return Array.from(node.childNodes).map(visibleText).join(' ');
}

const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

describe('the logo link (WCAG 2.5.3 Label in Name)', () => {
  it('store header: the name starts with the brand and contains everything that is shown', () => {
    renderApp(
      <ThemeProvider variant="web">
        <StoreHeader />
      </ThemeProvider>,
    );
    const link = screen.getByRole('link', { name: new RegExp(`^${BRAND.name}`) });
    expect(link).toHaveAccessibleName(`${BRAND.name} — bosh sahifa`);
    expect(norm(link.getAttribute('aria-label') ?? '')).toContain(norm(visibleText(link)));
    // Only the wordmark is exposed; the square mark is decoration.
    expect(link.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it('store header, Russian: the same, with the Russian label', () => {
    renderApp(
      <ThemeProvider variant="web">
        <StoreHeader />
      </ThemeProvider>,
      { locale: 'ru' },
    );
    const link = screen.getByRole('link', { name: new RegExp(`^${BRAND.name}`) });
    expect(link).toHaveAccessibleName(`${BRAND.name} — главная`);
    expect(norm(link.getAttribute('aria-label') ?? '')).toContain(norm(visibleText(link)));
  });

  it('login header: the same pattern', () => {
    render(
      <LoginShell
        homeHref="/"
        homeLabel={`${BRAND.name} — bosh sahifa`}
        backLabel="Orqaga"
        title="Kirish"
        subtitle="Telegram orqali"
        securityNote="Kodni hech kimga bermang"
      >
        <span />
      </LoginShell>,
    );
    const link = screen.getByRole('link', { name: new RegExp(`^${BRAND.name}`) });
    expect(norm(link.getAttribute('aria-label') ?? '')).toContain(norm(visibleText(link)));
    expect(link.querySelectorAll('[role="img"]')).toHaveLength(1);
  });
});
