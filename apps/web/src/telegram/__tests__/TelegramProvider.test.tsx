import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTgUiStore } from '../../stores/tg-ui-store';
import { TelegramProvider } from '../TelegramProvider';
import { useTelegram } from '../telegram-context';
import { createFakeWebApp, installWebApp, type FakeWebApp } from './fake-webapp';

function Phase() {
  const { phase } = useTelegram();
  return <span data-testid="phase">{phase}</span>;
}

const root = document.documentElement;
let uninstall: (() => void) | undefined;
let tokens: HTMLStyleElement;

beforeEach(() => {
  // The two --background values of tokens.css; the provider reads the one of the current theme.
  tokens = document.createElement('style');
  tokens.textContent = ':root{--background:#F2F4F9}[data-theme="dark"]{--background:#080C18}';
  document.head.append(tokens);
  useTgUiStore.setState({ locale: 'uz' });
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  tokens.remove();
  delete root.dataset.theme;
  root.removeAttribute('style');
});

function mount(app?: FakeWebApp) {
  if (app) uninstall = installWebApp(app);
  return render(
    <TelegramProvider>
      <Phase />
    </TelegramProvider>,
  );
}

describe('TelegramProvider inside Telegram', () => {
  it('tells Telegram the app is ready and expands it, once', () => {
    const app = createFakeWebApp();
    mount(app);
    expect(screen.getByTestId('phase')).toHaveTextContent('telegram');
    expect(app.ready).toHaveBeenCalledOnce();
    expect(app.expand).toHaveBeenCalledOnce();
  });

  it('follows the colour scheme, now and when Telegram changes it', () => {
    const app = createFakeWebApp({ colorScheme: 'dark' });
    mount(app);
    expect(root.dataset.theme).toBe('dark');
    act(() => {
      app.colorScheme = 'light';
      app.fire('themeChanged');
    });
    expect(root.dataset.theme).toBe('light');
  });

  it('paints the header, background and bottom bar with our --background of that theme', () => {
    const app = createFakeWebApp({ colorScheme: 'dark' });
    mount(app);
    expect(app.setHeaderColor).toHaveBeenLastCalledWith('#080C18');
    expect(app.setBackgroundColor).toHaveBeenLastCalledWith('#080C18');
    expect(app.setBottomBarColor).toHaveBeenLastCalledWith('#080C18');
    act(() => {
      app.colorScheme = 'light';
      app.fire('themeChanged');
    });
    expect(app.setHeaderColor).toHaveBeenLastCalledWith('#F2F4F9');
    expect(app.setBackgroundColor).toHaveBeenLastCalledWith('#F2F4F9');
  });

  it('survives a client that rejects the colour calls', () => {
    const app = createFakeWebApp();
    app.setHeaderColor = () => {
      throw new Error('WebAppMethodUnsupported');
    };
    expect(() => mount(app)).not.toThrow();
    expect(app.setBackgroundColor).toHaveBeenCalled();
  });

  it('puts the safe-area insets into CSS variables and keeps them current', () => {
    const app = createFakeWebApp();
    app.safeAreaInset = { top: 47, bottom: 34, left: 0, right: 0 };
    app.contentSafeAreaInset = { top: 0, bottom: 0, left: 0, right: 0 };
    mount(app);
    expect(root.style.getPropertyValue('--tg-safe-top')).toBe('47px');
    expect(root.style.getPropertyValue('--tg-safe-bottom')).toBe('34px');
    act(() => {
      app.contentSafeAreaInset = { top: 56, bottom: 0, left: 0, right: 0 };
      app.fire('contentSafeAreaChanged');
    });
    expect(root.style.getPropertyValue('--tg-safe-top')).toBe('103px');
    act(() => {
      app.safeAreaInset = { top: 0, bottom: 0, left: 0, right: 0 };
      app.fire('safeAreaChanged');
    });
    expect(root.style.getPropertyValue('--tg-safe-top')).toBe('56px');
  });

  it('stops listening when it unmounts', () => {
    const app = createFakeWebApp();
    const { unmount } = mount(app);
    unmount();
    expect(app.offEvent).toHaveBeenCalledWith('themeChanged', expect.any(Function));
    expect(app.offEvent).toHaveBeenCalledWith('safeAreaChanged', expect.any(Function));
    expect(app.offEvent).toHaveBeenCalledWith('contentSafeAreaChanged', expect.any(Function));
  });

  it('takes a first language guess from Telegram: ru for ru, be, uk, kk; uz for the rest', () => {
    for (const [code, expected] of [
      ['ru', 'ru'],
      ['uk', 'ru'],
      ['en', 'uz'],
      ['uz', 'uz'],
    ] as const) {
      useTgUiStore.setState({ locale: 'uz' });
      const { unmount } = mount(createFakeWebApp({ languageCode: code }));
      expect(useTgUiStore.getState().locale).toBe(expected);
      unmount();
      uninstall?.();
    }
  });
});

describe('TelegramProvider outside Telegram', () => {
  it('reports a browser, touches no Telegram API and leaves the safe-area variables alone', () => {
    mount();
    expect(screen.getByTestId('phase')).toHaveTextContent('browser');
    expect(root.style.getPropertyValue('--tg-safe-top')).toBe('');
  });

  it('treats the SDK object of a plain browser (empty initData) as no Telegram', () => {
    const app = createFakeWebApp({ initData: '' });
    mount(app);
    expect(screen.getByTestId('phase')).toHaveTextContent('browser');
    expect(app.ready).not.toHaveBeenCalled();
  });

  describe('in a plain browser (the bot gate)', () => {
    function mockOs(dark: boolean) {
      const listeners = new Set<() => void>();
      const media = {
        matches: dark,
        addEventListener: (_: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
      };
      vi.stubGlobal('matchMedia', () => media);
      return {
        flip: (next: boolean) => {
          media.matches = next;
          listeners.forEach((cb) => cb());
        },
      };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('follows the OS colour scheme, dark and light, and its changes', () => {
      const os = mockOs(true);
      mount();
      expect(root.dataset.theme).toBe('dark');
      act(() => os.flip(false));
      expect(root.dataset.theme).toBe('light');
      act(() => os.flip(true));
      expect(root.dataset.theme).toBe('dark');
    });

    it('is light when the OS says light', () => {
      mockOs(false);
      mount();
      expect(root.dataset.theme).toBe('light');
    });

    it('is light, without failing, where matchMedia does not exist', () => {
      mount();
      expect(root.dataset.theme).toBe('light');
    });

    it.each([
      ['ru-RU', 'ru'],
      ['uk', 'ru'],
      ['en-US', 'uz'],
      ['uz-UZ', 'uz'],
    ])('the gate language follows the browser language %s -> %s', (language, expected) => {
      vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(language);
      mount();
      expect(useTgUiStore.getState().locale).toBe(expected);
      vi.restoreAllMocks();
    });

    it('inside Telegram the browser language is not used', () => {
      vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('ru-RU');
      mount(createFakeWebApp({ languageCode: 'uz' }));
      expect(useTgUiStore.getState().locale).toBe('uz');
    });
  });
});
