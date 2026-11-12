import { NextIntlClientProvider } from 'next-intl';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../features/auth/AuthGuard';
import { AuthSync } from '../../features/auth/AuthSync';
import { MESSAGES } from '../../i18n/messages';
import { LOGIN_NAMESPACES, STORE_NAMESPACES } from '../../i18n/namespaces';
import { AppClientShell } from '../AppClientShell';
import LocaleLayout from '../[locale]/layout';
import LoginLayout from '../[locale]/login/layout';
import StoreLayout from '../[locale]/(store)/layout';
import { Providers } from '../providers';

// next/font cannot run outside Next.js; the request-scoped locale setter needs a request.
vi.mock('../fonts', () => ({ FONT_CLASSES: 'font-test' }));
vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));

type Props = { children?: ReactNode };

function find(node: ReactNode, wanted: unknown): ReactElement<Props> | null {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) {
      const hit = find(child, wanted);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!isValidElement<Props>(node)) return null;
  if (node.type === wanted) return node;
  return find(node.props.children, wanted);
}

const params = (locale: string) => Promise.resolve({ locale });
const child = <p>page</p>;

// The first provider that carries `messages`, as the keys it would serialise into the page.
function messageKeys(tree: ReactNode): string[] {
  const provider = find(tree, NextIntlClientProvider);
  expect(provider).not.toBeNull();
  const messages: unknown = provider?.props && Reflect.get(provider.props, 'messages');
  expect(typeof messages).toBe('object');
  return Object.keys(messages as object);
}

describe('[locale]/layout (the root of every website page)', () => {
  it.each(['uz', 'ru'] as const)(
    'serialises only `common` and the error page texts into the page (%s), never the whole catalog',
    async (locale) => {
      const tree = await LocaleLayout({ children: child, params: params(locale) });
      expect(messageKeys(tree)).toEqual(['common', 'site']);
      const provider = find(tree, NextIntlClientProvider);
      expect(Reflect.get(provider?.props ?? {}, 'messages')).toEqual({
        common: MESSAGES[locale].common,
        // Only the error page's three texts of `site`: the landing's copy stays on the server.
        site: { error: MESSAGES[locale].site.error },
      });
    },
  );

  it('carries the lazy cross-tab auth listener but no query client: a landing tab hears other tabs, cheaply', async () => {
    const tree = await LocaleLayout({ children: child, params: params('uz') });
    expect(find(tree, Providers)).toBeNull();
    expect(find(tree, AuthSync)).not.toBeNull();
    expect(find(tree, child.type)).not.toBeNull();
  });

  it('sets the document language from the URL', async () => {
    const tree = await LocaleLayout({ children: child, params: params('ru') });
    expect(isValidElement<{ lang?: string }>(tree) && tree.props.lang).toBe('ru');
  });

  it('answers 404 for an unknown locale', async () => {
    await expect(LocaleLayout({ children: child, params: params('de') })).rejects.toThrow();
  });
});

describe('AppClientShell', () => {
  it('gives its children the listed namespaces and the query client, and no auth listener of its own', () => {
    const tree = AppClientShell({ locale: 'ru', namespaces: ['common', 'web'], children: child });
    expect(messageKeys(tree)).toEqual(['common', 'web']);
    expect(find(tree, Providers)).not.toBeNull();
    expect(find(tree, AuthSync)).toBeNull();
    expect(Reflect.get(find(tree, NextIntlClientProvider)?.props ?? {}, 'locale')).toBe('ru');
  });
});

describe('(store)/layout', () => {
  it('moves the client machinery here, with the store namespaces, around the sign-in gate', async () => {
    const tree = await StoreLayout({ children: child, params: params('uz') });
    const shell = find(tree, AppClientShell);
    expect(shell).not.toBeNull();
    expect(Reflect.get(shell?.props ?? {}, 'namespaces')).toBe(STORE_NAMESPACES);
    expect(find(shell?.props.children, AuthGuard)).not.toBeNull();
    const rendered = AppClientShell({
      locale: 'uz',
      namespaces: STORE_NAMESPACES,
      children: shell?.props.children,
    });
    expect(messageKeys(rendered).sort()).toEqual([...STORE_NAMESPACES].sort());
  });

  it('answers 404 for an unknown locale', async () => {
    await expect(StoreLayout({ children: child, params: params('de') })).rejects.toThrow();
  });
});

describe('login/layout', () => {
  it('gives the sign-in page its own namespaces and no sign-in gate', async () => {
    const tree = await LoginLayout({ children: child, params: params('ru') });
    const shell = find(tree, AppClientShell);
    expect(shell).not.toBeNull();
    expect(Reflect.get(shell?.props ?? {}, 'namespaces')).toBe(LOGIN_NAMESPACES);
    expect(find(tree, AuthGuard)).toBeNull();
    expect(Reflect.get(shell?.props ?? {}, 'locale')).toBe('ru');
  });

  it('answers 404 for an unknown locale', async () => {
    await expect(LoginLayout({ children: child, params: params('de') })).rejects.toThrow();
  });
});
