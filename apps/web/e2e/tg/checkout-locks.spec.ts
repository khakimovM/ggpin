import { expect, test, type Page } from '@playwright/test';
import { tgPressMain } from '../fixtures/telegram';
import { TEXT, mainButton, openCheckout, reachConfirm } from './checkout-support';

// Real Web Locks (Chromium has them, localhost is a secure context): two pages of ONE browser
// context. While one of them has a payment on its way, the other sends nothing and says so; when
// the first is gone, the second can ask again - with the SAME Idempotency-Key (phase 7 S7 review).

const STARS = 'telegram-stars';
const t = TEXT.uz.store.checkout;
const dialog = (page: Page) => page.getByRole('dialog');

test.describe('a payment on its way in another window', () => {
  test('the other page sends nothing and says so; once the first is gone it asks again with the SAME key', async ({
    page,
    context,
  }) => {
    // Page A: the order is made on the server, the answer never comes (the lock stays held).
    const a = await openCheckout(page, STARS, { orders: { post: 'hangOnce' } });
    await reachConfirm(page);
    await tgPressMain(page);
    await expect.poll(() => a.orders.posts.length).toBe(1);
    const lockHeld = await page.evaluate(async () => {
      const state = await navigator.locks.query();
      return (state.held ?? []).some((lock) => lock.name?.startsWith('ggpin:order-attempt:'));
    });
    expect(lockHeld).toBe(true); // a REAL Web Lock, not a fake

    // Page B: same browser. It finds A's record ("result unknown") and tries to check.
    const second = await context.newPage();
    const b = await openCheckout(second, STARS);
    await reachConfirm(second);
    await expect(dialog(second).getByText(t.uncertain.title)).toBeVisible();
    await expect
      .poll(() => mainButton(second))
      .toMatchObject({ enabled: true, text: t.uncertain.retry });
    await tgPressMain(second);
    await expect(dialog(second).getByText(t.busy)).toBeVisible();
    expect(b.orders.posts).toHaveLength(0); // nothing left page B

    // Page A goes away: its lock is released, and B may ask - for the SAME purchase.
    await page.close();
    await expect
      .poll(() => mainButton(second))
      .toMatchObject({ enabled: true, text: t.uncertain.retry });
    await expect(async () => {
      await tgPressMain(second);
      await expect(second).toHaveURL(/\/tg\/orders\/order_1$/, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    expect(b.orders.posts).toHaveLength(1);
    expect(b.orders.posts[0]?.key).toBe(a.orders.posts[0]?.key);
    expect(b.orders.posts[0]?.quoteId).toBe(a.orders.posts[0]?.quoteId);
  });
});
