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
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return scan.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`);
};
