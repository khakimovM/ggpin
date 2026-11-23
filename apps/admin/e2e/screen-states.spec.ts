import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { MOCK_STATE_KEY, chooseTheme, seedMock, shotPath, type ThemeName } from './support/mock';

async function seriousViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(' | ')}`,
    );
}

test.describe('view states (loading, empty, error)', () => {
  for (const theme of ['light', 'dark'] as ThemeName[]) {
    test(`users and dashboard, ${theme}`, async ({ page }, testInfo) => {
      // A 5xx is retried twice with backoff (lib/query-client.ts) before the error state shows.
      test.slow();
      const settled = { timeout: 15_000 };
      await chooseTheme(page, theme);
      const name = (state: string, screen: string) =>
        shotPath(`s5-state-${screen}-${state}-${testInfo.project.name}-${theme}`);

      await seedMock(page, { signedIn: true, role: 'OWNER', scenario: 'loading' });
      await page.goto('/users');
      await expect(page.getByRole('table', { name: 'Foydalanuvchilar' })).toHaveAttribute(
        'aria-busy',
        'true',
      );
      await page.screenshot({ path: name('loading', 'users') });

      const setScenario = (scenario: string) =>
        page.evaluate(
          ([key, value]) => {
            const state = JSON.parse(window.sessionStorage.getItem(key) ?? '{}') as Record<
              string,
              unknown
            >;
            window.sessionStorage.setItem(key, JSON.stringify({ ...state, scenario: value }));
          },
          [MOCK_STATE_KEY, scenario] as const,
        );

      await setScenario('empty');
      await page.reload();
      await expect(page.getByText('Foydalanuvchi topilmadi')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Filtrlarni tozalash' })).toBeVisible();
      await page.screenshot({ path: name('empty', 'users') });

      await setScenario('error');
      await page.reload();
      await expect(page.getByRole('alert').getByText('Maʼlumotni yuklab bo‘lmadi')).toBeVisible(
        settled,
      );
      await page.screenshot({ path: name('error', 'users') });
      await setScenario('data');
      await page.getByRole('button', { name: 'Qayta urinish' }).click();
      await expect(page.getByText('@sardor_r')).toBeVisible();

      await setScenario('empty');
      await page.goto('/dashboard');
      await expect(page.getByText('Hammasi joyida: ochiq ogohlantirish yo‘q')).toBeVisible();
      await page.screenshot({ path: name('empty', 'dashboard'), fullPage: true });
      await setScenario('error');
      await page.reload();
      await expect(page.getByRole('button', { name: 'Qayta urinish' }).first()).toBeVisible(
        settled,
      );
      await page.screenshot({ path: name('error', 'dashboard') });
    });
  }
});

test.describe('filters live in the URL', () => {
  test.beforeEach(async ({ page }) => {
    await seedMock(page, { signedIn: true, role: 'OWNER' });
  });

  test('users: status pill and search survive a reload', async ({ page }) => {
    await page.goto('/users');
    await expect(page.getByText('@sardor_r')).toBeVisible();
    await page.getByRole('button', { name: 'Muzlatilgan' }).click();
    await expect(page).toHaveURL(/status=FROZEN/);
    await expect(page.getByText('@bek_99')).toBeVisible();
    await expect(page.getByText('@sardor_r')).toBeHidden();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Muzlatilgan' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText('@bek_99')).toBeVisible();

    await page.getByRole('button', { name: 'Barchasi' }).click();
    await page.getByRole('searchbox', { name: 'Foydalanuvchini qidirish' }).fill('jasur');
    await expect(page).toHaveURL(/q=jasur/);
    await expect(page.getByText('@jasur_t')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('searchbox', { name: 'Foydalanuvchini qidirish' })).toHaveValue(
      'jasur',
    );
  });

  test('payments: tab, status and kind filters are links', async ({ page }) => {
    await page.goto('/payments');
    await page.getByRole('button', { name: 'Hal qilingan' }).click();
    await expect(page).toHaveURL(/status=RESOLVED/);
    await expect(page.getByText('Foydalanuvchiga hisoblandi').first()).toBeVisible();
    await page.getByRole('link', { name: 'So‘rovlar' }).click();
    await expect(page).toHaveURL(/tab=intents$/);
    await page.getByRole('button', { name: 'EXPIRED' }).click();
    await expect(page).toHaveURL(/status=EXPIRED/);
    await page.reload();
    await expect(page.getByText('mkint000004')).toBeVisible();
    await expect(page.getByText('mkint000001')).toBeHidden();
    // Filters replace the history entry (a typed search must not fill Back), tabs push one: Back
    // leaves the intents tab for the reviews tab with its filter.
    await page.goBack();
    await expect(page).toHaveURL(/\/payments\?status=RESOLVED$/);
  });
});

test('closing a drawer adds no history entry: Back never reopens it (R-5)', async ({ page }) => {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
  await page.goto('/dashboard');
  await expect(page.getByText('Ogohlantirishlar')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Admin menyu' })
    .getByRole('link', { name: 'To‘lovlar' })
    .click();
  await expect(page).toHaveURL(/\/payments$/);
  const review = page.getByRole('dialog', { name: 'To‘lov tekshiruvi' });

  // Opened inside the app: Esc steps back over the entry the drawer pushed.
  await page.getByRole('table').getByRole('button').first().click();
  await expect(review).toBeVisible();
  await expect(page).toHaveURL(/review=/);
  await page.keyboard.press('Escape');
  await expect(review).toBeHidden();
  await expect(page).toHaveURL(/\/payments$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(review).toHaveCount(0);

  // Arrived with the URL (a shared link): Esc replaces the entry, Back leaves the screen.
  await page.goto('/payments?review=mkrev000003');
  await expect(review).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/payments$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(review).toHaveCount(0);
});

test('a page past the end of a list moves to the last page (R-8)', async ({ page }) => {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
  await page.goto('/users?page=99');
  await expect(page.getByText('@sardor_r')).toBeVisible();
  await expect(page).toHaveURL(/\/users$/);
});

test('a role without the right sees the lock state, not the data', async ({ page }) => {
  await seedMock(page, { signedIn: true, role: 'SUPPORT' });
  await page.goto('/audit');
  await expect(page.getByText('Sizning rolingiz: SUPPORT')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.goto('/users');
  await expect(page.getByText('@sardor_r')).toBeVisible();
});

test('a session that ends mid-use sends the admin to the login with the notice', async ({
  page,
}) => {
  await seedMock(page, { signedIn: true, role: 'OWNER' });
  await page.goto('/users');
  await expect(page.getByText('@sardor_r')).toBeVisible();
  // The server forgets the session (expiry, revoke); the next real read is a 404 and the
  // /me probe confirms the session is gone.
  await page.evaluate((key) => {
    const state = JSON.parse(window.sessionStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    window.sessionStorage.setItem(key, JSON.stringify({ ...state, signedIn: false }));
  }, MOCK_STATE_KEY);
  await page
    .getByRole('navigation', { name: 'Admin menyu' })
    .getByRole('link', { name: 'Audit log' })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('Sessiya tugadi. Davom etish uchun qayta kiring.')).toBeVisible();
});

// One page per test: axe takes seconds per page, and a failure names the page it is about.
const AXE_VISITS: readonly [string, string][] = [
  ['/dashboard', 'Ogohlantirishlar'],
  // Orders, review and products carry the premium chip (HELD, "featured"): R-2 contrast.
  ['/orders', '#48213'],
  ['/review', 'SUPPLIER_TIMEOUT'],
  ['/products', 'telegram-stars'],
  ['/fragment', 'Sessiya faol'],
  ['/users', '@sardor_r'],
  ['/users/mkuser000001?tab=ledger', 'Referal bonusi'],
  ['/payments', 'Summaga mos so‘rov topilmadi'],
  ['/payments?tab=cards', 'HUMO •4417'],
  ['/recon', 'Hisobga olinmagan kirim'],
  ['/products/mkprod000001?sku=mksku000001', 'Minimal marjadan yuqori'],
  ['/pricing', 'Kurs manbalari'],
  ['/audit?entry=mkaud000002', 'USER_FREEZE'],
  ['/admins', 'Faol sessiyalar'],
  ['/orders/mkord000001', 'Bajarish urinishlari'],
  ['/wallet', 'Hot wallet'],
  ['/queues', 'fulfill-order'],
];

for (const theme of ['light', 'dark'] as ThemeName[]) {
  test.describe(`axe on the read screens, ${theme}`, () => {
    for (const [path, ready] of AXE_VISITS) {
      test(path, async ({ page }) => {
        await chooseTheme(page, theme);
        await seedMock(page, { signedIn: true, role: 'OWNER' });
        await page.goto(path);
        await expect(page.getByText(ready).filter({ visible: true }).first()).toBeVisible();
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  });
}
