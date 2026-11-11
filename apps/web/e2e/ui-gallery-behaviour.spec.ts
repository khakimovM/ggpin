import { expect, test } from '@playwright/test';
import { expectHitArea44, openGallery } from './support/gallery';

// Behaviour, tokens, touch targets and Russian fit of the component gallery (/dev/ui).

test.describe('theme and tokens', () => {
  test('the same utility classes resolve to the light and the dark token values', async ({
    page,
  }) => {
    await openGallery(page, 'light', 'uz');
    const primary = page
      .locator('[data-section="actions"]')
      .getByRole('button', { name: 'Sotib olish' })
      .first();
    await expect(primary).toHaveCSS('background-color', 'rgb(61, 75, 245)');
    await expect(primary).toHaveCSS('border-radius', '12px');

    await page.getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(primary).toHaveCSS('background-color', 'rgb(74, 87, 255)');
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('ggpin-theme')))
      .toBe('dark');
  });

  test('buttons keep a 44px touch target (sm is padded, md and lg are taller)', async ({
    page,
  }) => {
    await openGallery(page, 'light', 'uz');
    const actions = page.locator('[data-section="actions"]');
    const md = await actions.getByRole('button', { name: 'md · Sotib olish' }).boundingBox();
    const lg = await actions.getByRole('button', { name: 'lg · To‘lash' }).boundingBox();
    expect(md?.height).toBeGreaterThanOrEqual(44);
    expect(lg?.height).toBeGreaterThanOrEqual(52);
    await expectHitArea44(actions.getByRole('button', { name: 'sm · Sotib olish' }));
  });

  test('chips, small switch, small segmented control, toast close: a 44px target each', async ({
    page,
  }) => {
    await openGallery(page, 'light', 'uz');
    const selection = page.locator('[data-section="selection"]');
    await expectHitArea44(selection.getByRole('button', { name: 'Yetkazildi', exact: true }));
    await expectHitArea44(selection.getByRole('button', { name: '100 ⭐' }));
    // size="sm": the language switch and the reduced-motion switch live in the sticky toolbar
    await expectHitArea44(
      page
        .getByRole('radiogroup', { name: 'Sample language' })
        .getByRole('radio', { name: 'Русский' }),
    );
    await expectHitArea44(page.getByRole('switch', { name: 'Reduced motion' }));
    await expectHitArea44(
      page.locator('[data-section="inputs"]').getByRole('switch', { name: /\(sm\)/ }),
    );
    await page.getByRole('button', { name: 'persistent', exact: true }).click();
    await expectHitArea44(page.getByRole('button', { name: 'Yopish' }));
  });

  test('removable chip: the X has a 44px target and a tap on the label never removes it', async ({
    page,
  }) => {
    await openGallery(page, 'light', 'uz');
    const selection = page.locator('[data-section="selection"]');
    const remove = selection.getByRole('button', { name: 'Olib tashlash' }).first();
    await expectHitArea44(remove);

    // the right end of the label text, the closest a tap on the label gets to the X
    const label = selection.getByText('PUBG Mobile', { exact: true }).first();
    const box = await label.boundingBox();
    if (!box) throw new Error('label has no box');
    await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
    await expect(remove).toBeVisible();

    await remove.click();
    // (the disabled sample chip has the same button name, so look for the removed label)
    await expect(label).toHaveCount(0);
  });

  test('sheet back and close buttons keep a 44px target', async ({ page }) => {
    await openGallery(page, 'light', 'uz');
    await page.getByRole('button', { name: 'Buyurtmani tasdiqlang' }).click();
    const dialog = page.getByRole('dialog', { name: 'Buyurtmani tasdiqlang' });
    await expect(dialog).toBeVisible();
    await expectHitArea44(dialog.getByRole('button', { name: 'Yopish' }));
    await dialog.getByRole('button', { name: 'Keyingi qadam' }).click();
    const step2 = page.getByRole('dialog', { name: 'Qabul qiluvchi' });
    await expectHitArea44(step2.getByRole('button', { name: 'Orqaga' }));
  });

  test('the new radii resolve: card 20, tile 16, control 12, badge 8', async ({ page }) => {
    await openGallery(page, 'light', 'uz');
    const radius = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((node) => getComputedStyle(node).borderTopLeftRadius);
    expect(await radius('[data-section="containers"] .rounded-lg')).toBe('20px');
    expect(await radius('[data-section="actions"] .rounded-tile')).toBe('16px');
    expect(await radius('[data-section="actions"] .rounded-control')).toBe('12px');
    expect(await radius('[data-section="selection"] .rounded-badge')).toBe('8px');
  });

  test('danger button uses the AA-safe fills: --danger-hover on light, --danger on dark', async ({
    page,
  }) => {
    await openGallery(page, 'light', 'uz');
    const danger = page
      .locator('[data-section="actions"]')
      .getByRole('button', { name: /^O‘chirish/ });
    await expect(danger).toHaveCSS('background-color', 'rgb(204, 38, 57)');
    await page.getByRole('radio', { name: 'Dark' }).click();
    await expect(danger).toHaveCSS('background-color', 'rgb(255, 84, 104)');
    await expect(danger).toHaveCSS('color', 'rgb(8, 12, 24)');
  });
});

test.describe('reduced motion', () => {
  test('the profile switch sets data-reduced and the skeleton shimmer disappears', async ({
    page,
  }) => {
    await openGallery(page, 'light', 'uz');
    const shimmer = page.locator('[data-section="states"] [aria-busy="true"] span > span');
    await expect(shimmer.first()).toBeAttached();
    await page.getByRole('switch', { name: 'Reduced motion' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-reduced', 'true');
    await expect(shimmer).toHaveCount(0);
    // tokens.css disables CSS animation under [data-reduced="true"]
    const spinner = page
      .locator('[data-section="actions"] svg.animate-\\[gg-spin_900ms_linear_infinite\\]')
      .first();
    await expect(spinner).toHaveCSS('animation-name', 'none');
  });

  test('the OS setting alone removes the shimmer too', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openGallery(page, 'light', 'uz');
    await expect(
      page.locator('[data-section="states"] [aria-busy="true"] span > span'),
    ).toHaveCount(0);
  });
});

test.describe('interactions', () => {
  test('the money input groups digits and quick chips add to the amount', async ({ page }) => {
    await openGallery(page, 'light', 'uz');
    const field = page.getByLabel('To‘ldirish summasi');
    await expect(field).toHaveValue(/^150\s000$/);
    await page.getByRole('button', { name: '+50 000' }).click();
    await expect(field).toHaveValue(/^200\s000$/);
    await field.fill('x');
    await expect(field).toHaveValue('');
  });

  test('pasting a code fills the OTP boxes and submits once', async ({ page }) => {
    await openGallery(page, 'light', 'uz');
    const first = page.getByLabel('Kod, 1-raqam');
    await first.focus();
    await first.evaluate((input) => {
      const data = new DataTransfer();
      data.setData('text', '482913');
      input.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await expect(page.getByLabel('Kod, 6-raqam')).toHaveValue('3');
    await expect(page.getByTestId('otp-last')).toHaveText('onComplete: 482913');
    await expect(page.getByLabel('Kod, 1-raqam')).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('a wrong code turns the boxes red with a visible message', async ({ page }) => {
    await openGallery(page, 'light', 'uz');
    await page.getByLabel('Kod, 1-raqam').focus();
    await page.keyboard.type('111111');
    await expect(page.getByLabel('Kod, 1-raqam')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Kod noto‘g‘ri. 2 ta urinish qoldi')).toBeVisible();
  });

  test('toasts appear, announce and close', async ({ page }) => {
    await openGallery(page, 'light', 'uz');
    await page.getByRole('button', { name: 'success', exact: true }).click();
    // One live mechanism: polite region for the message, assertive for errors, no nested roles.
    const polite = page.locator('[aria-live="polite"]').filter({ hasText: 'Yetkazildi' });
    await expect(polite).toBeVisible();
    await polite.getByRole('button', { name: 'Yopish' }).click();
    await expect(polite).toHaveCount(0);

    await page.getByRole('button', { name: 'error', exact: true }).click();
    const assertive = page.locator('[aria-live="assertive"]').filter({ hasText: 'To‘lov o‘tmadi' });
    await expect(assertive).toBeVisible();
    await expect(
      page.locator('[aria-live] [role="alert"], [aria-live] [role="status"]'),
    ).toHaveCount(0);
  });

  test('the sheet opens, traps focus, steps back and closes with Escape', async ({ page }) => {
    await openGallery(page, 'light', 'uz');
    const opener = page.getByRole('button', { name: 'Buyurtmani tasdiqlang' });
    // Opened from the keyboard: Safari does not focus a button on mouse click, so only a
    // keyboard opener has focus to give back.
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Buyurtmani tasdiqlang' });
    await expect(dialog).toBeVisible();

    for (let press = 0; press < 6; press += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }

    await dialog.getByRole('button', { name: 'Keyingi qadam' }).click();
    await expect(page.getByRole('dialog', { name: 'Qabul qiluvchi' })).toBeVisible();
    await page.getByRole('button', { name: 'Orqaga' }).click();
    await expect(page.getByRole('dialog', { name: 'Buyurtmani tasdiqlang' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('keyboard: Tab reaches the tabs and arrow keys switch them', async ({ page }) => {
    await openGallery(page, 'light', 'uz');
    const tab = page.getByRole('tab', { name: 'Hammasi' });
    await tab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'O‘yinlar' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('the timeline advances and keeps exactly one current step', async ({ page }) => {
    await openGallery(page, 'light', 'uz');
    const list = page.getByRole('list', { name: 'Buyurtma holati' });
    await expect(list.locator('[aria-current="step"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Keyingi qadam' }).last().click();
    await expect(list.locator('[data-state="done"]')).toHaveCount(3);
    await expect(list.locator('[aria-current="step"]')).toHaveCount(1);
  });
});

test.describe('Russian copy fits', () => {
  test('the longest labels wrap inside their controls instead of overflowing', async ({ page }) => {
    await openGallery(page, 'light', 'ru');
    const long = page.getByRole('button', { name: 'Пополнить на 37 050 сум и купить' });
    const box = await long.boundingBox();
    const scroll = await long.evaluate((node) => ({ w: node.scrollWidth, c: node.clientWidth }));
    expect(box?.height).toBeGreaterThanOrEqual(52);
    expect(scroll.w).toBeLessThanOrEqual(scroll.c);

    const chip = page.locator('[data-status="REFUNDED"]').first();
    const overflow = await chip.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
