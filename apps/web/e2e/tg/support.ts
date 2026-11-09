import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  E2E_BOT_TOKEN,
  installFakeWebApp,
  signInitData,
  type FakeWebAppOptions,
} from '../fixtures/telegram';
import { installTgApi, type LoginAnswer } from '../fixtures/tg-api';

// Shared by the Mini App specs: a signed-in launch, and the checks every screen goes through.

export const INIT_DATA = signInitData(
  { user: { id: 424242, first_name: 'Sardor', language_code: 'uz' } },
  E2E_BOT_TOKEN,
);

export interface OpenOptions extends FakeWebAppOptions {
  answers?: LoginAnswer[];
}

/** Opens /tg as a Telegram user (fake WebApp, faked API) and returns the API double. */
export async function open(page: Page, { answers, ...webApp }: OpenOptions = {}) {
  await installFakeWebApp(page, { initData: INIT_DATA, ...webApp });
  const api = await installTgApi(page, answers);
  await page.goto('/tg');
  return api;
}

export const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

export const axeViolations = async (page: Page) => {
  // A fade or a rise in progress makes text semi-transparent for a moment, and the contrast check
  // would read that frame: let every finite animation finish first (loops are left running). A
  // finite animation that never ends (a stuck test, a huge delay) must not hang the run: after 3 s
  // the wait gives up and says which animations were still going.
  const stuck = await page.evaluate(async (limitMs) => {
    const running = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    const names = (list: Animation[]) =>
      list.map((animation) =>
        animation instanceof CSSAnimation ? animation.animationName : animation.id || 'animation',
      );
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), limitMs),
    );
    const done = Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
    const result = await Promise.race([done, timeout]);
    return result === 'timeout'
      ? names(running.filter((animation) => animation.playState !== 'finished'))
      : [];
  }, 3000);
  if (stuck.length > 0)
    console.warn(`axe: animations still running after 3 s: ${stuck.join(', ')}`);
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return scan.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`);
};
