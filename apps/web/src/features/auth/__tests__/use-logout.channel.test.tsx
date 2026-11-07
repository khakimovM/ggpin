import { act, renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import uz from '@repo/i18n/uz.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogout } from '../use-logout';
import { testQueryClient } from './test-utils';

const mocks = vi.hoisted(() => {
  const state: { channel: 'web' | 'tg' } = { channel: 'web' };
  return { state, logout: vi.fn(() => Promise.resolve()), hardNavigate: vi.fn() };
});

vi.mock('../../../lib/api/auth', () => ({ logout: mocks.logout }));
vi.mock('../../../lib/api/client', () => ({
  getActiveAuth: () => ({ channel: mocks.state.channel }),
}));
vi.mock('../../../lib/navigation', () => ({ hardNavigate: mocks.hardNavigate }));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="ru" messages={uz}>
      <QueryClientProvider client={testQueryClient()}>{children}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

async function signOut() {
  const { result } = renderHook(() => useLogout(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync();
  });
}

beforeEach(() => {
  mocks.hardNavigate.mockClear();
  mocks.logout.mockClear();
});

describe('useLogout destination', () => {
  it('web: goes to the home page of the visitor locale', async () => {
    mocks.state.channel = 'web';
    await signOut();
    expect(mocks.hardNavigate).toHaveBeenCalledExactlyOnceWith('/ru');
  });

  it('Mini App: reloads /tg and never the web site', async () => {
    mocks.state.channel = 'tg';
    await signOut();
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.hardNavigate).toHaveBeenCalledExactlyOnceWith('/tg');
  });
});
