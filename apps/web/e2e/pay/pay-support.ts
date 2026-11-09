import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import type { Page, TestInfo } from '@playwright/test';
import {
  INTENT_ID,
  PAY_TOKEN,
  installPaymentsApi,
  type PaymentsApi,
  type PaymentsApiOptions,
} from '../fixtures/payments';

// Shared by the pay page, Mini App top-up and store top-up specs (phase 7 S8).

export const TEXT = { uz, ru } as const;
export type Lang = keyof typeof TEXT;
export const SCHEMES = ['light', 'dark'] as const;
export type Scheme = (typeof SCHEMES)[number];

export interface OpenPay {
  lang?: Lang;
  scheme?: Scheme;
  /** What follows `#` in the opened URL; `null` opens the page without a fragment. */
  hash?: string | null;
  /** The language query as the link carries it; `null` = no `?locale=` at all. */
  locale?: string | null;
  payments?: PaymentsApiOptions;
}

/** Opens `/pay/<id>?locale=<lang>#t=<token>` the way the Mini App's `openLink` does. */
export async function openPay(page: Page, opts: OpenPay = {}): Promise<PaymentsApi> {
  const { lang = 'uz', scheme = 'light' } = opts;
  await page.addInitScript((stored) => window.localStorage.setItem('ggpin-theme', stored), scheme);
  const api = await installPaymentsApi(page, opts.payments);
  const locale = opts.locale === undefined ? lang : opts.locale;
  const hash = opts.hash === undefined ? `t=${PAY_TOKEN}` : opts.hash;
  await page.goto(
    `/pay/${opts.payments?.intentId ?? INTENT_ID}${locale === null ? '' : `?locale=${locale}`}${hash === null ? '' : `#${hash}`}`,
  );
  return api;
}

/**
 * Screenshots for the owner's review (375 and 1440 wide, uz and ru, light and dark). Written only
 * when `S8_SHOTS_DIR` is set, to `<dir>/<name>.png`; a normal run writes nothing.
 */
export async function shot(page: Page, testInfo: TestInfo, name: string) {
  const dir = process.env['S8_SHOTS_DIR'];
  if (dir === undefined || dir === '') return;
  // A fixed bar would float in the middle of a stitched full-page picture: the window is made as
  // tall as the page instead, so the bar sits where it sits for a visitor who scrolled to the end.
  const size = page.viewportSize();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  if (size !== null && height > size.height) {
    await page.setViewportSize({ width: size.width, height: Math.min(height, 4000) });
    await page.waitForTimeout(150);
  }
  await page.screenshot({
    path: `${dir}/${name}-${testInfo.project.name}.png`,
    animations: 'disabled',
  });
  if (size !== null) await page.setViewportSize(size);
}

export const t = (lang: Lang) => TEXT[lang].pay;
export const main = (page: Page) => page.locator('main');
/** The tab's storage key of the pay token of the default request. */
export const STORE_KEY = `ggpin:pay:${INTENT_ID}`;
export const DONE_KEY = `ggpin:pay-done:${INTENT_ID}`;
export const noToken = (url: string) => !url.includes('#t=') && !url.includes(PAY_TOKEN);
