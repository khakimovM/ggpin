import uz from '@repo/i18n/uz.json';
import type { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import { qk } from '../../../lib/query-keys';
import { TEST_INIT_DATA } from '../../../telegram/__tests__/fake-webapp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTgUiStore } from '../../../stores/tg-ui-store';
import { createFakeWebApp, type FakeWebApp } from '../../../telegram/__tests__/fake-webapp';
import { type GateOptions, ME, fail, newClient, ok, renderGateWith } from './tg-gate-kit';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  // The links the gates build come from env; the tests change them per case.
  env: {
    NEXT_PUBLIC_API_URL: 'http://localhost:5000/api/v1',
    NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_BOT_USERNAME: 'ggpin_bot',
    NEXT_PUBLIC_API_MOCKS: [] as string[],
    NEXT_PUBLIC_SUPPORT_URL: '',
  },
  pathname: '/tg',
}));
vi.mock('../../../env', () => ({ env: mocks.env }));
vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../../../lib/api/client', () => ({
  activateTgAuth: () => ({ login: mocks.login }),
}));

let client: QueryClient;
let app: FakeWebApp;
const renderGate = (options?: GateOptions) => renderGateWith(client, app, options);

beforeEach(() => {
  client = newClient();
  app = createFakeWebApp();
  window.Telegram = { WebApp: app };
  useTgUiStore.setState({ locale: 'uz' });
  mocks.login.mockReset();
  mocks.env.NEXT_PUBLIC_SUPPORT_URL = '';
  mocks.env.NEXT_PUBLIC_BOT_USERNAME = 'ggpin_bot';
  mocks.pathname = '/tg';
});

afterEach(() => {
  delete window.Telegram;
  vi.restoreAllMocks();
});

describe('TgGate', () => {
  it('shows the splash while Telegram is being detected, and does not sign in yet', () => {
    renderGate({ phase: 'detecting' });
    expect(screen.getByRole('progressbar', { name: uz.tg.splash.label })).toBeInTheDocument();
    expect(screen.getByText(uz.tg.splash.signingIn)).toBeInTheDocument();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('shows the splash while the sign-in runs, then the app, with the user cached', async () => {
    let finish: (value: Awaited<ReturnType<typeof ok>>) => void = () => undefined;
    mocks.login.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderGate();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByText('app content')).not.toBeInTheDocument();
    await act(async () => finish(await ok()));
    expect(await screen.findByText('app content')).toBeInTheDocument();
    expect(client.getQueryData(qk.me())).toEqual(ME);
    expect(mocks.login).toHaveBeenCalledOnce();
  });

  it('adopts the profile locale', async () => {
    mocks.login.mockReturnValue(ok({ ...ME, locale: 'ru' }));
    renderGate();
    await screen.findByText('app content');
    expect(useTgUiStore.getState().locale).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
  });

  describe('the native BackButton', () => {
    it('stays hidden during the splash and on every gate', async () => {
      mocks.pathname = '/tg/orders';
      let finish: (value: Awaited<ReturnType<typeof ok>>) => void = () => undefined;
      mocks.login.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      renderGate();
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(app.BackButton.show).not.toHaveBeenCalled();
      await act(async () => finish(await ok()));
      await screen.findByText('app content');
      expect(app.BackButton.show).toHaveBeenCalledOnce();
    });

    it.each([
      ['blocked', () => fail('USER_BLOCKED', 403)],
      ['reopen', () => fail('INITDATA_EXPIRED', 401)],
      ['offline', () => fail('NETWORK')],
    ])('%s gate: never shown', async (_name, answer) => {
      mocks.pathname = '/tg/orders';
      mocks.login.mockImplementation(answer);
      renderGate();
      await screen.findByRole('heading');
      expect(app.BackButton.show).not.toHaveBeenCalled();
    });

    it('the gate coming back in the middle of a visit takes the button away', async () => {
      mocks.pathname = '/tg/orders';
      mocks.login.mockReturnValue(ok());
      renderGate();
      await screen.findByText('app content');
      expect(app.BackButton.show).toHaveBeenCalledOnce();
      await act(async () => {
        await client
          .fetchQuery({ queryKey: ['wallet'], queryFn: () => fail('USER_BLOCKED', 403) })
          .catch(() => undefined);
      });
      await screen.findByRole('heading', { name: uz.tg.gate.blocked.title });
      expect(app.BackButton.hide).toHaveBeenCalled();
    });
  });

  it('never shows the initData, in the page or in the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    mocks.login.mockImplementation(() => fail('INITDATA_EXPIRED', 401));
    renderGate();
    await screen.findByRole('heading', { name: uz.tg.gate.reopen.title });
    expect(document.body.innerHTML).not.toContain(TEST_INIT_DATA);
    expect(document.body.innerHTML).not.toContain('auth_date');
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TEST_INIT_DATA);
    }
    await waitFor(() => expect(mocks.login).toHaveBeenCalled());
    // login() takes no argument: the initData is read inside the auth module, at request time.
    expect(mocks.login.mock.calls[0]).toEqual([]);
  });
});
