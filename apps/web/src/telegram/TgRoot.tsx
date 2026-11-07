'use client';

import type { ReactNode } from 'react';
import { Providers } from '../app/providers';
import { TgGate } from '../features/tg-auth/TgGate';
import { TelegramProvider } from './TelegramProvider';
import { TgIntlProvider, type TgCatalogs } from './TgIntlProvider';

/**
 * Everything the Mini App screens run inside, outermost first: the Telegram connection (theme,
 * safe area), the language, the query client, and the gate that stands between a visitor and the
 * app until Telegram has signed them in. The server layout only supplies the catalogs.
 */
export function TgRoot({ catalogs, children }: { catalogs: TgCatalogs; children: ReactNode }) {
  return (
    <TelegramProvider>
      <TgIntlProvider catalogs={catalogs}>
        <Providers>
          <TgGate>{children}</TgGate>
        </Providers>
      </TgIntlProvider>
    </TelegramProvider>
  );
}
