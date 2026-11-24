import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  MOCK_CODE,
  chooseTheme,
  seedMock,
  setVoidScenario,
  setWriteScenario,
  shotPath,
  type ThemeName,
} from './support/mock';
import { oppositeInFlight, oppositeLocked, oppositeVoided } from './support/opposite';

// 9B-3 on the mock API: two tabs on one key (N-2), the add dialog after a reload (R-3), and the
// owner's screenshots of the void states at 1440/768 in both themes, each checked with axe.

const USER = '/users/mkuser000001';
const REASON = 'Shubhali faollik, tekshiruv uchun';
const RESOLVE = 'Natijani aniqlash';
const JOURNAL = 'ggpin-admin-mock-writes';

async function serious(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => `${violation.id}: ${violation.nodes.map((n) => n.target).join(' | ')}`);
}

async function unknownBlock(page: Page): Promise<Locator> {
  await page.goto(USER);
  await setWriteScenario(page, 'fail500');
  await page.getByRole('button', { name: 'Bloklash' }).click();
  const dialog = page.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await dialog.getByRole('button', { name: 'Bloklash' }).click();
  await expect(dialog.getByRole('button', { name: RESOLVE })).toBeVisible();
  return dialog;
}

/** A second tab that starts with this tab's sessionStorage (a duplicated tab). */
async function duplicate(context: BrowserContext, page: Page): Promise<Page> {
  const stored = await page.evaluate(() => JSON.stringify({ ...window.sessionStorage }));
  const twin = await context.newPage();
  await twin.addInitScript((raw) => {
    if (window.sessionStorage.getItem('twin:copied') !== null) return;
    for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
      window.sessionStorage.setItem(key, value);
    }
    window.sessionStorage.setItem('twin:copied', '1');
  }, stored);
  return twin;
}

test('two tabs on one key (N-2): both get VOIDED for the one tombstone, then fresh keys', async ({
  page,
  context,
}) => {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
  await unknownBlock(page);
  const twin = await duplicate(context, page);
  await page.getByRole('dialog').getByRole('button', { name: RESOLVE }).click();
  await expect(page.getByText(/Avvalgi so‘rov bajarilmagan/)).toBeVisible();
  // The second tab sees the same "server" (the mock journal with the tombstone).
  const journal = await page.evaluate((key) => window.sessionStorage.getItem(key), JOURNAL);
  await twin.goto(USER);
  await twin.evaluate(([key, value]) => window.sessionStorage.setItem(key, value ?? ''), [
    JOURNAL,
    journal,
  ] as const);
  await twin.getByRole('button', { name: 'Bloklash' }).click();
  const other = twin.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
  await expect(other.getByRole('status')).toContainText(/Natija nomaʼlum/);
  await expect(other.getByRole('button', { name: 'Bloklash' })).toBeDisabled();
  await other.getByRole('button', { name: RESOLVE }).click();
  await expect(other.getByText(/Avvalgi so‘rov bajarilmagan/)).toBeVisible();
  await other.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
  await other.getByRole('button', { name: 'Bloklash' }).click();
  await expect(other).toBeHidden();
  const after = await twin.evaluate((key) => window.sessionStorage.getItem(key), JOURNAL);
  expect(after?.match(/"IDEMPOTENCY_VOID"/g)).toHaveLength(1);
  expect(after?.match(/"USER_BLOCK"/g)).toHaveLength(1);
});

async function unknownAdd(page: Page): Promise<Locator> {
  await page.goto('/admins');
  await page.getByRole('button', { name: 'Admin qo‘shish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Admin qo‘shish' });
  await dialog.getByRole('textbox', { name: 'Telegram ID' }).fill('5550000007');
  await dialog.getByRole('textbox', { name: 'Ism' }).fill('Ali V.');
  await dialog.getByRole('textbox', { name: /Sabab/ }).fill('Adminlar boshqaruvi: 9B-3 tekshiruvi');
  await dialog.getByRole('button', { name: 'Kodni olish' }).click();
  await dialog.getByRole('textbox', { name: 'Kod, 1-raqam' }).click();
  await page.keyboard.type(MOCK_CODE);
  await setWriteScenario(page, 'fail500');
  await dialog.getByRole('button', { name: 'Qo‘shish' }).click();
  await expect(dialog.getByRole('button', { name: RESOLVE })).toBeVisible();
  return dialog;
}

test('the add dialog after a reload: empty, locked, explained; the void names the Telegram ID', async ({
  page,
}) => {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
  await unknownAdd(page);
  await page.reload();
  await page.getByRole('button', { name: 'Admin qo‘shish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Admin qo‘shish' });
  await expect(dialog.getByRole('textbox', { name: 'Telegram ID' })).toHaveValue('');
  await expect(dialog.getByRole('textbox', { name: 'Telegram ID' })).toBeDisabled();
  await expect(dialog.getByText(/sahifa yangilanganda o‘chdi/)).toBeVisible();
  await dialog.getByRole('button', { name: RESOLVE }).click();
  await expect(dialog.getByRole('textbox', { name: 'Telegram ID' })).toBeEnabled();
  const journal = await page.evaluate((key) => window.sessionStorage.getItem(key), JOURNAL);
  expect(journal).toContain('"IDEMPOTENCY_VOID"');
  expect(journal).toContain('"targetId":"5550000007"');
});

interface Shot {
  name: string;
  open: (page: Page) => Promise<Locator>;
}

const SHOTS: Shot[] = [
  { name: 'unknown-locked', open: unknownBlock },
  {
    name: 'voided',
    open: async (page) => {
      const dialog = await unknownBlock(page);
      await dialog.getByRole('button', { name: RESOLVE }).click();
      await expect(dialog.getByText(/Avvalgi so‘rov bajarilmagan/)).toBeVisible();
      return dialog;
    },
  },
  {
    name: 'void-failed',
    open: async (page) => {
      const dialog = await unknownBlock(page);
      await setVoidScenario(page, 'deadline503');
      await dialog.getByRole('button', { name: RESOLVE }).click();
      await expect(dialog.getByText(/Natijani aniqlab bo‘lmadi/)).toBeVisible();
      return dialog;
    },
  },
  {
    name: 'deadline',
    open: async (page) => {
      await page.goto(USER);
      await setWriteScenario(page, 'deadline503');
      await page.getByRole('button', { name: 'Bloklash' }).click();
      const dialog = page.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
      await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
      await dialog.getByRole('button', { name: 'Bloklash' }).click();
      await expect(dialog.getByRole('alert')).toContainText('hech narsa yozilmadi');
      return dialog;
    },
  },
  {
    name: 'deadline-code',
    open: async (page) => {
      await page.goto('/payments?tab=cards');
      const humo = page.getByRole('group', { name: 'HUMO •4417 kartasi amallari' });
      await humo.getByRole('button', { name: 'Chiqarish' }).click();
      const dialog = page.getByRole('dialog', { name: 'Kartani foydalanishdan chiqarish' });
      await dialog.getByRole('button', { name: 'Kodni olish' }).click();
      await dialog.getByRole('textbox', { name: 'Kod, 1-raqam' }).click();
      await page.keyboard.type(MOCK_CODE);
      await dialog.getByRole('textbox', { name: /Sabab/ }).fill('Karta yopildi, yangisi ochiladi');
      await setWriteScenario(page, 'deadline503');
      await dialog.getByRole('button', { name: 'Chiqarish' }).click();
      await expect(dialog.getByText(/Yangi kod oling/)).toBeVisible();
      return dialog;
    },
  },
  {
    name: 'conflict',
    open: async (page) => {
      await page.goto(USER);
      await setWriteScenario(page, 'conflict');
      await page.getByRole('button', { name: 'Bloklash' }).click();
      const dialog = page.getByRole('dialog', { name: 'Foydalanuvchini bloklash' });
      await dialog.getByRole('textbox', { name: /Sabab/ }).fill(REASON);
      await dialog.getByRole('button', { name: 'Bloklash' }).click();
      await expect(dialog.getByText(/kalit avval ishlatilgan yoki bekor qilingan/)).toBeVisible();
      return dialog;
    },
  },
  { name: 'opposite-locked', open: oppositeLocked },
  { name: 'opposite-voided', open: oppositeVoided },
  { name: 'opposite-in-flight', open: oppositeInFlight },
  {
    name: 'add-reload-locked',
    open: async (page) => {
      await unknownAdd(page);
      await page.reload();
      await page.getByRole('button', { name: 'Admin qo‘shish' }).click();
      const dialog = page.getByRole('dialog', { name: 'Admin qo‘shish' });
      await expect(dialog.getByText(/sahifa yangilanganda o‘chdi/)).toBeVisible();
      return dialog;
    },
  },
];

for (const theme of ['light', 'dark'] as ThemeName[]) {
  test.describe(`9B-3 void states, ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await chooseTheme(page, theme);
      await seedMock(page, { signedIn: true, role: 'OWNER' });
    });

    for (const shot of SHOTS) {
      test(shot.name, async ({ page }, testInfo) => {
        const dialog = await shot.open(page);
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Bekor' })).toBeInViewport();
        await page.screenshot({
          path: shotPath(`9b3-${shot.name}-${testInfo.project.name}-${theme}`),
          fullPage: false,
        });
        expect(await serious(page)).toEqual([]);
      });
    }
  });
}
