import { expect, test } from '@playwright/test';
import { axeViolations, overflow } from '../tg/support';
import {
  SCHEMES,
  TEXT,
  buyButton,
  openProductPage,
  shot,
  usernameField,
  type Lang,
} from './product-support';
import { saveShot } from './shot-file';

// Phase 6 P6-W1 on the web store product page (the Mini App twin is e2e/tg/product-premium.spec.ts;
// the rest of this page is in product.spec.ts, which has no room left under the 300-line limit):
// the three "already has Premium" states (owner decision Q1: none, `has` = a non-blocking yellow
// note, `blocked` = the 422) and the term rows ("{price}/oy", "Eng foydali", Q6). With SHOTS_DIR
// set, the screenshots are also written there for the comparison with Product.dc.html.

const PREMIUM = 'telegram-premium';
const STATES = { none: 'aziz_k', has: 'prem_ext', blocked: 'prem_user' } as const;
const PER_MONTH: Record<Lang, RegExp[]> = {
  uz: [/55.000\s*so‘m\/oy/, /36.700\s*so‘m\/oy/, /33.000\s*so‘m\/oy/],
  ru: [/55.000\s*сум\/мес/, /36.700\s*сум\/мес/, /33.000\s*сум\/мес/],
};

for (const state of ['none', 'has', 'blocked'] as const) {
  for (const lang of ['uz', 'ru'] as const) {
    for (const scheme of SCHEMES) {
      test(`${state} / ${lang} / ${scheme}`, async ({ page }, testInfo) => {
        const t = TEXT[lang];
        const r = t.store.product.recipient;
        await openProductPage(page, PREMIUM, {
          lang,
          scheme,
          product: { recipients: { prem_ext: 'hasPremiumExtends', prem_user: 'hasPremium' } },
        });
        const radios = page
          .getByRole('radiogroup', { name: t.store.product.sku.plans })
          .getByRole('radio');
        await expect(radios).toHaveCount(3);
        for (const [index, perMonth] of PER_MONTH[lang].entries()) {
          await expect(radios.nth(index)).toContainText(perMonth);
        }
        const best = t.store.product.sku.best;
        await expect(radios.nth(2).getByText(best, { exact: true })).toBeVisible();
        await expect(page.getByText(best, { exact: true })).toHaveCount(1);
        await radios.nth(1).click();

        await usernameField(page).fill(STATES[state]);
        await page.getByRole('button', { name: r.check, exact: true }).click();
        const note = page.getByRole('status').filter({ hasText: t.warnings.premiumExtends });
        const buy = buyButton(page, lang);
        if (state === 'blocked') {
          await expect(page.getByRole('alert').filter({ hasText: r.blocked.title })).toBeVisible();
          await expect(note).toHaveCount(0);
          // The visible buy button says why it is off (the bottom bar or the panel's block).
          const off = page.getByRole('button', { name: r.blocked.title, exact: true });
          await expect(off).toHaveCount(1);
          await expect(off).toBeDisabled();
          await expect(buy).toHaveCount(0);
        } else {
          await expect(page.getByRole('button', { name: r.confirm, exact: true })).toBeVisible();
          await expect(note).toHaveCount(state === 'has' ? 1 : 0);
          await page.getByRole('button', { name: r.confirm, exact: true }).click();
          await expect(note).toHaveCount(state === 'has' ? 1 : 0);
          await expect(buy).toBeEnabled();
        }
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(await axeViolations(page)).toEqual([]);
        const name = `store-premium-${state}-${lang}-${scheme}`;
        await shot(page, testInfo, name);
        if (process.env.SHOTS_DIR) await saveShot(page, process.env.SHOTS_DIR, name);
      });
    }
  }
}
