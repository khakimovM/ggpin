import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { chooseTheme, seedMock, setWriteScenario, shotPath, type ThemeName } from './support/mock';

// S7b action dialogs for the owner's review (AdminOps.dc.html dialog frames), at 1440 and 768 in
// both themes, each checked with axe (serious / critical) while open.

async function serious(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(' | ')}`,
    );
}

interface Shot {
  name: string;
  path: string;
  open: (page: Page) => Promise<Locator>;
}

const SHOTS: Shot[] = [
  {
    name: 'block',
    path: '/users/mkuser000001',
    open: async (page) => {
      await page.getByRole('button', { name: 'Bloklash' }).click();
      return page.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
    },
  },
  {
    name: 'adjust',
    path: '/users/mkuser000001',
    open: async (page) => {
      await page.getByRole('button', { name: 'Balansni tuzatish' }).click();
      const dialog = page.getByRole('dialog', { name: 'Balansni tuzatish' });
      await dialog.getByRole('textbox', { name: 'Summa', exact: true }).fill('150 000');
      await expect(dialog.getByText('Ochiq buyurtmalar')).toBeVisible();
      return dialog;
    },
  },
  {
    name: 'review-credit',
    path: '/payments?review=mkrev000002',
    open: async (page) => {
      await page.getByRole('button', { name: 'Hisobga o‘tkazish' }).click();
      const dialog = page.getByRole('dialog', { name: 'Hisobga o‘tkazish' });
      await expect(dialog.getByText('Hisoblashdan oldin')).toBeVisible();
      return dialog;
    },
  },
  {
    name: 'card-limit',
    path: '/payments?tab=cards',
    open: async (page) => {
      await page
        .getByRole('group', { name: 'HUMO •4417 kartasi amallari' })
        .getByRole('button', { name: 'Limit' })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Karta limiti' });
      await dialog.getByRole('textbox', { name: 'Qabul limiti' }).fill('400 000 000');
      return dialog;
    },
  },
  {
    name: 'outcome-unknown',
    path: '/users/mkuser000001',
    open: async (page) => {
      await setWriteScenario(page, 'fail500');
      await page.getByRole('button', { name: 'Bloklash' }).click();
      const dialog = page.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
      await dialog
        .getByRole('textbox', { name: /Sabab/ })
        .fill('Shubhali faollik, tekshiruv uchun');
      await dialog.getByRole('button', { name: 'Bloklash' }).click();
      await expect(dialog.getByRole('status')).toBeVisible();
      return dialog;
    },
  },
];

for (const theme of ['light', 'dark'] as ThemeName[]) {
  test.describe(`S7b dialogs, ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await chooseTheme(page, theme);
      await seedMock(page, { signedIn: true, role: 'OWNER' });
    });

    for (const shot of SHOTS) {
      test(shot.name, async ({ page }, testInfo) => {
        await page.goto(shot.path);
        const dialog = await shot.open(page);
        await expect(dialog).toBeVisible();
        // CR-5: the footer stays on screen however tall the dialog is (1440x900 and 768).
        await expect(dialog.getByRole('button', { name: 'Bekor' })).toBeInViewport();
        await page.screenshot({
          path: shotPath(`s7b-${shot.name}-${testInfo.project.name}-${theme}`),
          fullPage: false,
        });
        expect(await serious(page)).toEqual([]);
      });
    }

    test('cards with their actions', async ({ page }, testInfo) => {
      await page.goto('/payments?tab=cards');
      await expect(page.getByRole('group', { name: 'HUMO •4417 kartasi amallari' })).toBeVisible();
      await page.screenshot({ path: shotPath(`s7b-cards-${testInfo.project.name}-${theme}`) });
      expect(await serious(page)).toEqual([]);
    });

    test('user page with notes', async ({ page }, testInfo) => {
      await page.goto('/users/mkuser000001');
      await expect(page.getByRole('heading', { name: 'Izohlar' })).toBeVisible();
      await page.screenshot({
        path: shotPath(`s7b-user-${testInfo.project.name}-${theme}`),
        fullPage: true,
      });
      expect(await serious(page)).toEqual([]);
    });
  });
}

test('keyboard only: open the block dialog, type the reason, send, Esc closes another', async ({
  page,
}) => {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
  await page.goto('/users/mkuser000001');
  await expect(page.getByText('Jami xarid')).toBeVisible();
  const block = page.getByRole('button', { name: 'Bloklash' });
  await block.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
  await expect(dialog).toBeVisible();
  const reason = dialog.getByRole('textbox', { name: /Sabab/ });
  for (
    let step = 0;
    step < 5 && !(await reason.evaluate((el) => el === document.activeElement));
    step += 1
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(reason).toBeFocused();
  await page.keyboard.type('Shubhali faollik, tekshiruv uchun');
  const send = dialog.getByRole('button', { name: 'Bloklash' });
  for (
    let step = 0;
    step < 5 && !(await send.evaluate((el) => el === document.activeElement));
    step += 1
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(send).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const freeze = page.getByRole('button', { name: 'Xaridni muzlatish' });
  await freeze.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Xaridni muzlatish' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(freeze).toBeFocused();
});
