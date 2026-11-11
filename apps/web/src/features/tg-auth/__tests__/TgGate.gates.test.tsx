import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { env } from '../../../env';
import type { ErrorCode } from './tg-gate-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTgUiStore } from '../../../stores/tg-ui-store';
import { createFakeWebApp, type FakeWebApp } from '../../../telegram/__tests__/fake-webapp';
import { type GateOptions, fail, newClient, ok, renderGateWith } from './tg-gate-kit';

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

describe('TgGate gates', () => {
  describe('gates', () => {
    it('bot: outside Telegram, with a link to the bot from the environment', () => {
      renderGate({ phase: 'browser' });
      expect(screen.getByRole('heading', { name: uz.tg.gate.bot.title })).toBeInTheDocument();
      const link = screen.getByRole('link', { name: uz.tg.gate.bot.cta });
      expect(link).toHaveAttribute('href', 'https://t.me/ggpin_bot');
      // The username is read from env each time, never written into the code.
      expect(env.NEXT_PUBLIC_BOT_USERNAME).toBe('ggpin_bot');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
      expect(mocks.login).not.toHaveBeenCalled();
    });

    describe('blocked: the support button', () => {
      const blocked = async () => {
        mocks.login.mockImplementation(() => fail('USER_BLOCKED', 403));
        renderGate();
        await screen.findByRole('heading', { name: uz.tg.gate.blocked.title });
      };

      it('no support link configured: no button and no link, and no retry either', async () => {
        await blocked();
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
      });

      it('a t.me link opens inside Telegram (openTelegramLink), not in an external browser', async () => {
        mocks.env.NEXT_PUBLIC_SUPPORT_URL = 'https://t.me/ggpin_support';
        await blocked();
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: uz.tg.gate.blocked.cta }));
        expect(app.openTelegramLink).toHaveBeenCalledExactlyOnceWith('https://t.me/ggpin_support');
        expect(app.openLink).not.toHaveBeenCalled();
      });

      it('any other link is an ordinary link that opens in a new tab', async () => {
        mocks.env.NEXT_PUBLIC_SUPPORT_URL = 'https://help.example.test/ggpin';
        await blocked();
        const link = screen.getByRole('link', { name: uz.tg.gate.blocked.cta });
        expect(link).toHaveAttribute('href', 'https://help.example.test/ggpin');
        expect(link).toHaveAttribute('target', '_blank');
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(app.openTelegramLink).not.toHaveBeenCalled();
      });
    });

    it.each(['INITDATA_EXPIRED', 'INITDATA_INVALID'] as const)(
      '%s: asks to reopen the app, and closes it',
      async (code) => {
        mocks.login.mockImplementation(() => fail(code, 401));
        renderGate();
        expect(
          await screen.findByRole('heading', { name: uz.tg.gate.reopen.title }),
        ).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: uz.tg.gate.reopen.cta }));
        expect(app.close).toHaveBeenCalledOnce();
        expect(mocks.login).toHaveBeenCalledOnce();
      },
    );

    it('offline: retry signs in again and lets the visitor in', async () => {
      mocks.login.mockImplementationOnce(() => fail('NETWORK')).mockImplementation(() => ok());
      renderGate();
      expect(
        await screen.findByRole('heading', { name: uz.tg.gate.offline.title }),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: uz.common.retry }));
      expect(await screen.findByText('app content')).toBeInTheDocument();
      expect(mocks.login).toHaveBeenCalledTimes(2);
    });

    it('offline: coming back online retries by itself', async () => {
      mocks.login.mockImplementationOnce(() => fail('NETWORK')).mockImplementation(() => ok());
      const listen = vi.spyOn(window, 'addEventListener');
      renderGate();
      await screen.findByRole('heading', { name: uz.tg.gate.offline.title });
      // The listener is added by an effect that can run a moment after the screen is painted.
      await waitFor(() => expect(listen).toHaveBeenCalledWith('online', expect.any(Function)));
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      expect(await screen.findByText('app content')).toBeInTheDocument();
    });

    it('any other failure: the server message and a retry', async () => {
      mocks.login.mockImplementation(() => fail('RATE_LIMITED', 429));
      renderGate();
      expect(
        await screen.findByRole('heading', { name: uz.tg.gate.error.title }),
      ).toBeInTheDocument();
      expect(screen.getByText(uz.errors.RATE_LIMITED)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: uz.common.retry })).toBeInTheDocument();
    });

    it('speaks Russian when the language is Russian', async () => {
      useTgUiStore.setState({ locale: 'ru' });
      mocks.login.mockImplementation(() => fail('NETWORK'));
      renderGate();
      expect(
        await screen.findByRole('heading', { name: ru.tg.gate.offline.title }),
      ).toBeInTheDocument();
      expect(screen.getByText(ru.tg.gate.offline.body)).toBeInTheDocument();
    });

    it('the gate comes back when a later request ends the session for good', async () => {
      mocks.login.mockReturnValue(ok());
      renderGate();
      await screen.findByText('app content');
      await act(async () => {
        await client
          .fetchQuery({ queryKey: ['wallet'], queryFn: () => fail('USER_BLOCKED', 403) })
          .catch(() => undefined);
      });
      expect(
        await screen.findByRole('heading', { name: uz.tg.gate.blocked.title }),
      ).toBeInTheDocument();
    });

    it('an ordinary failure of a later request does not close the app', async () => {
      mocks.login.mockReturnValue(ok());
      renderGate();
      await screen.findByText('app content');
      await act(async () => {
        await client
          .fetchQuery({ queryKey: ['wallet'], queryFn: () => fail('INTERNAL_ERROR', 500) })
          .catch(() => undefined);
      });
      expect(screen.getByText('app content')).toBeInTheDocument();
    });
  });

  describe('a mutation that ends the session closes the app too', () => {
    const run = async (code: ErrorCode, status: number) => {
      mocks.login.mockReturnValue(ok());
      renderGate();
      await screen.findByText('app content');
      await act(async () => {
        await new MutationObserver(client, { mutationFn: () => fail(code, status) })
          .mutate()
          .catch(() => undefined);
      });
    };

    it('USER_BLOCKED', async () => {
      await run('USER_BLOCKED', 403);
      expect(
        await screen.findByRole('heading', { name: uz.tg.gate.blocked.title }),
      ).toBeInTheDocument();
    });

    it.each(['INITDATA_EXPIRED', 'INITDATA_INVALID'] as const)('%s', async (code) => {
      await run(code, 401);
      expect(
        await screen.findByRole('heading', { name: uz.tg.gate.reopen.title }),
      ).toBeInTheDocument();
    });

    it('an ordinary failure of a mutation does not close the app', async () => {
      await run('INSUFFICIENT_BALANCE', 422);
      expect(screen.getByText('app content')).toBeInTheDocument();
    });
  });
});
