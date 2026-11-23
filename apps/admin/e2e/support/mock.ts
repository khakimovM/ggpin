import type { Page } from '@playwright/test';

// Mirrors src/lib/api/mock/mock-state.ts: the dev mock reads its state from sessionStorage, so a
// test chooses the starting point (signed in, role, failing login) before the page loads.
export const MOCK_STATE_KEY = 'ggpin-admin-mock';

export interface MockSeed {
  signedIn?: boolean;
  role?: 'OWNER' | 'OPERATOR' | 'SUPPORT';
  startFails?: boolean;
  deny?: boolean;
  pendingPolls?: number;
  /** How the read endpoints answer: the four view states of every screen. */
  scenario?: 'data' | 'empty' | 'error' | 'loading';
  /** How the next mock write answers (one-shot, mock-state.ts `writeScenario`). */
  writeScenario?: WriteScenario;
}

export type WriteScenario = 'ok' | 'applyThen500' | 'fail500' | 'conflict' | 'applyThenCodeExpired';

/** Sets how the NEXT write answers, on a page that is already open (one-shot). */
export async function setWriteScenario(page: Page, writeScenario: WriteScenario): Promise<void> {
  await page.evaluate(
    ([key, value]) => {
      const current = JSON.parse(window.sessionStorage.getItem(key) ?? '{}') as object;
      window.sessionStorage.setItem(key, JSON.stringify({ ...current, writeScenario: value }));
    },
    [MOCK_STATE_KEY, writeScenario] as const,
  );
}

/** The code the mock sends to "Telegram": any six digits but 000000 (the wrong one). */
export const MOCK_CODE = '123456';

/** Seeds the mock once per page (a reload keeps what the app wrote since, like a cookie). */
export async function seedMock(page: Page, seed: MockSeed): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (window.sessionStorage.getItem(`${key}:seeded`) !== null) return;
      window.sessionStorage.setItem(key, value);
      window.sessionStorage.setItem(`${key}:seeded`, '1');
    },
    [MOCK_STATE_KEY, JSON.stringify(seed)] as const,
  );
}

export type ThemeName = 'light' | 'dark';

/** Chooses the theme the way the app stores it, before the page loads. */
export async function chooseTheme(page: Page, theme: ThemeName): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem('ggpin-theme', value), theme);
}

/** Where screenshots for the owner go (copied to the session scratchpad after the run). */
export function shotPath(name: string): string {
  return `test-results/shots/${name}.png`;
}
