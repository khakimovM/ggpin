import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import type { Me } from '@repo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApiError } from '../../../lib/api/errors';
import { TelegramContext } from '../../../telegram/telegram-context';
import { TgIntlProvider } from '../../../telegram/TgIntlProvider';
import type { FakeWebApp } from '../../../telegram/__tests__/fake-webapp';
import { TgGate } from '../TgGate';

// Shared by TgGate.test.tsx and TgGate.gates.test.tsx. The vi.mock calls cannot live here (they
// must be in each test file), so each file declares its own and passes its client and WebApp in.

export const ME: Me = {
  id: 'user_1',
  telegramId: '123456789',
  username: 'sardor_r',
  firstName: 'Sardor',
  photoUrl: null,
  locale: 'uz',
  referralCode: 'REF123',
  phoneLinked: false,
};
export const CATALOGS = {
  uz: { common: uz.common, errors: uz.errors, tg: uz.tg, store: uz.store, wallet: uz.wallet },
  ru: { common: ru.common, errors: ru.errors, tg: ru.tg, store: ru.store, wallet: ru.wallet },
};

export type ErrorCode = ConstructorParameters<typeof ApiError>[0]['code'];
export const ok = (user: Me = ME) => Promise.resolve({ expiresIn: 3600, user });
export const fail = (code: ErrorCode, status = 0) => Promise.reject(new ApiError({ status, code }));

export function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

export interface GateOptions {
  phase?: 'detecting' | 'telegram' | 'browser';
  webApp?: FakeWebApp | null;
  children?: ReactNode;
}

export function renderGateWith(client: QueryClient, app: FakeWebApp, options: GateOptions = {}) {
  const { phase = 'telegram', webApp = app, children = <p>app content</p> } = options;
  return render(
    <TelegramContext.Provider value={{ phase, webApp: phase === 'telegram' ? webApp : null }}>
      <TgIntlProvider catalogs={CATALOGS}>
        <QueryClientProvider client={client}>
          <TgGate>{children}</TgGate>
        </QueryClientProvider>
      </TgIntlProvider>
    </TelegramContext.Provider>,
  );
}
