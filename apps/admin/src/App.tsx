import { ThemeProvider } from '@repo/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { IntlProvider } from 'use-intl';
import { AdminToasts } from './app/AdminToasts';
import { createAdminRouter } from './app/router';
import { ADMIN_LOCALE, ADMIN_TIME_ZONE, messages } from './lib/i18n';
import { makeQueryClient } from './lib/query-client';

/** Providers of the admin SPA: server state, Uzbek texts (D-05), theme, toasts, then the routes. */
export function App() {
  const [queryClient] = useState(makeQueryClient);
  const [router] = useState(createAdminRouter);
  return (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale={ADMIN_LOCALE} messages={messages} timeZone={ADMIN_TIME_ZONE}>
        <ThemeProvider variant="web">
          <AdminToasts>
            <RouterProvider router={router} />
          </AdminToasts>
        </ThemeProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
}
