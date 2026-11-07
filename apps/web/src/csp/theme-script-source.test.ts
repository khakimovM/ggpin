import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TG_THEME_SCRIPT, WEB_THEME_SCRIPT } from './theme-script-source';

// The scripts are strings that run in the page before React exists, so they are tested by running
// them the way a page does: as an inline <script> element (jsdom executes it).
function run(source: string): void {
  const element = document.createElement('script');
  element.textContent = source;
  document.head.append(element);
  element.remove();
}

const root = document.documentElement;

// The page script sees the jsdom window's own globals, so test doubles are installed by running
// code in that window too (assigning to Node's globalThis would be invisible to it).
function mockScheme(dark: boolean) {
  run(
    `window.matchMedia=function(q){return{matches:${String(dark)}&&q.indexOf('prefers-color-scheme: dark')>-1}}`,
  );
}

beforeEach(() => {
  delete root.dataset.theme;
  delete root.dataset.reduced;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.location.hash = '';
});

afterEach(() => {
  run('delete window.matchMedia;delete window.Telegram');
});

describe('web theme script', () => {
  it('uses the stored choice over the OS setting', () => {
    mockScheme(true);
    window.localStorage.setItem('ggpin-theme', 'light');
    run(WEB_THEME_SCRIPT);
    expect(root.dataset.theme).toBe('light');
    window.localStorage.setItem('ggpin-theme', 'dark');
    mockScheme(false);
    run(WEB_THEME_SCRIPT);
    expect(root.dataset.theme).toBe('dark');
  });

  it('follows the OS when nothing, or "system", is stored', () => {
    mockScheme(true);
    run(WEB_THEME_SCRIPT);
    expect(root.dataset.theme).toBe('dark');
    window.localStorage.setItem('ggpin-theme', 'system');
    mockScheme(false);
    run(WEB_THEME_SCRIPT);
    expect(root.dataset.theme).toBe('light');
  });

  it('honours the stored reduced-motion switch', () => {
    mockScheme(false);
    window.localStorage.setItem('ggpin-reduced-motion', 'true');
    run(WEB_THEME_SCRIPT);
    expect(root.dataset.reduced).toBe('true');
  });

  it('survives blocked storage', () => {
    mockScheme(true);
    run(
      "window.__getItem=Storage.prototype.getItem;Storage.prototype.getItem=function(){throw new Error('blocked')}",
    );
    // A script that throws is reported as a window "error" event, not as an exception of run().
    const errors: string[] = [];
    const listener = (event: ErrorEvent) => errors.push(event.message);
    window.addEventListener('error', listener);
    try {
      run(WEB_THEME_SCRIPT);
      expect(errors).toEqual([]);
      expect(root.dataset.theme).toBeUndefined();
    } finally {
      window.removeEventListener('error', listener);
      run('Storage.prototype.getItem=window.__getItem;delete window.__getItem');
    }
  });
});

describe('telegram theme script', () => {
  const params = (bg: string) => encodeURIComponent(JSON.stringify({ bg_color: bg }));

  it('prefers the SDK colour scheme when the SDK is already there', () => {
    run("window.Telegram={WebApp:{colorScheme:'dark'}}");
    run(TG_THEME_SCRIPT);
    expect(root.dataset.theme).toBe('dark');
  });

  it('reads the theme parameters from the hash with the SDK brightness rule', () => {
    window.location.hash = `tgWebAppData=user%3Dx&tgWebAppThemeParams=${params('#17212b')}`;
    run(TG_THEME_SCRIPT);
    expect(root.dataset.theme).toBe('dark');
    window.location.hash = `tgWebAppThemeParams=${params('#ffffff')}&tgWebAppVersion=8.0`;
    run(TG_THEME_SCRIPT);
    expect(root.dataset.theme).toBe('light');
  });

  it('falls back to the copy the SDK keeps in sessionStorage', () => {
    window.sessionStorage.setItem(
      '__telegram__themeParams',
      JSON.stringify({ bg_color: '#000000' }),
    );
    run(TG_THEME_SCRIPT);
    expect(root.dataset.theme).toBe('dark');
  });

  it('is light for no parameters, and for garbage', () => {
    run(TG_THEME_SCRIPT);
    expect(root.dataset.theme).toBe('light');
    window.location.hash = 'tgWebAppThemeParams=%7Bnot-json';
    expect(() => run(TG_THEME_SCRIPT)).not.toThrow();
    expect(root.dataset.theme).toBe('light');
    window.location.hash = `tgWebAppThemeParams=${params('red')}`;
    run(TG_THEME_SCRIPT);
    expect(root.dataset.theme).toBe('light');
  });
});
