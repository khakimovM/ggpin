import { expect, test } from '@playwright/test';
import { axeViolations, overflow } from '../tg/support';
import {
  TEXT,
  buyButton,
  confirmRecipient,
  openProductPage,
  shot,
  usernameField,
  type Lang,
} from './product-support';

// The web product page when the server says what it holds is out of date (phase 7 S6 review): a
// quote answered RECIPIENT_INVALID (the recipient token is dead). The page sends the visitor back
// to look the person up and confirm again, instead of offering a retry that cannot work.

for (const lang of ['uz', 'ru'] as Lang[]) {
  test(`${lang}: RECIPIENT_INVALID on a quote -> confirm again, no retry loop`, async ({
    page,
  }, testInfo) => {
    const t = TEXT[lang].store.product;
    const api = await openProductPage(page, 'telegram-stars', {
      lang,
      product: { quote: 'recipientInvalid' },
    });
    await confirmRecipient(page, lang);

    await expect(page.getByText(t.recipient.expired)).toBeVisible();
    await expect(usernameField(page)).toHaveValue('aziz_k');
    await expect(page.getByText(t.recipient.unconfirmed)).toBeVisible();
    await expect(buyButton(page, lang)).toBeDisabled();
    await expect(buyButton(page, lang)).toHaveText(t.buy.needRecipient);

    await page.waitForTimeout(1200);
    expect(api.quoteBodies).toHaveLength(1); // one answer, and nothing by itself after it
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, testInfo, `recipient-expired-${lang}`);

    // Looking the person up again asks the server again, and shows them for confirmation.
    api.setQuote('ok');
    await confirmRecipient(page, lang);
    await expect(buyButton(page, lang)).toBeEnabled();
    expect(api.recipientBodies).toHaveLength(2);
  });
}
