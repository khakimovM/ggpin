import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';

const CATALOGS = { uz, ru } as const;

export type TestLocale = keyof typeof CATALOGS;

/** A client that never retries or caches between tests: failures show up at once. */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

export function renderApp(
  ui: ReactElement,
  { locale = 'uz', client = testQueryClient() }: { locale?: TestLocale; client?: QueryClient } = {},
): RenderResult & { client: QueryClient } {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={CATALOGS[locale]}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </NextIntlClientProvider>
    );
  }
  return Object.assign(render(ui, { wrapper: Wrapper }), { client });
}

/** Lets pending promises (mutations, queries) settle under real timers. */
export const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
