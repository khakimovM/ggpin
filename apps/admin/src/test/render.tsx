import { ThemeProvider } from '@repo/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { ADMIN_LOCALE, ADMIN_TIME_ZONE, messages } from '../lib/i18n';

/** Renders with the admin's providers (texts, theme, a fresh query client without retries). */
export function renderAdmin(ui: ReactNode): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale={ADMIN_LOCALE} messages={messages} timeZone={ADMIN_TIME_ZONE}>
        <ThemeProvider variant="web">{ui}</ThemeProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}
