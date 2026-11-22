import { expect, test } from '@playwright/test';
import { chooseTheme, seedMock, shotPath, type ThemeName } from './support/mock';

// Every S5 read screen as OWNER on the mock API, at both widths and in both themes. The ready
// marker is a piece of fixture data, so the shot is taken after the data, not the skeleton.
const SCREENS: readonly { name: string; path: string; h1: string | RegExp; ready: string }[] = [
  { name: 'dashboard', path: '/dashboard', h1: 'Dashboard', ready: 'Ogohlantirishlar' },
  { name: 'orders', path: '/orders', h1: 'Buyurtmalar', ready: '#48213' },
  { name: 'order', path: '/orders/mkord000002', h1: /#48212/, ready: 'Bajarish urinishlari' },
  { name: 'review', path: '/review', h1: 'Tekshiruv navbati', ready: 'SUPPLIER_TIMEOUT' },
  { name: 'users', path: '/users', h1: 'Foydalanuvchilar', ready: '@sardor_r' },
  { name: 'user', path: '/users/mkuser000001', h1: 'Sardor Rahimov', ready: 'Jami xarid' },
  { name: 'products', path: '/products', h1: 'Mahsulotlar', ready: 'telegram-stars' },
  {
    name: 'product',
    path: '/products/mkprod000001?sku=mksku000006',
    h1: 'Telegram Stars',
    ready: 'Marja minimaldan past',
  },
  { name: 'pricing', path: '/pricing', h1: 'Narx va sozlamalar', ready: 'Eng kam to‘ldirish' },
  { name: 'payments', path: '/payments', h1: 'To‘lovlar', ready: 'Summaga mos so‘rov topilmadi' },
  {
    name: 'payments-intents',
    path: '/payments?tab=intents',
    h1: 'To‘lovlar',
    ready: 'mkint000002',
  },
  { name: 'payments-cards', path: '/payments?tab=cards', h1: 'To‘lovlar', ready: 'HUMO •4417' },
  { name: 'recon', path: '/recon', h1: 'Solishtirish', ready: 'Hisobga olinmagan kirim' },
  { name: 'wallet', path: '/wallet', h1: 'Hamyon (TON)', ready: 'Hot wallet' },
  { name: 'fragment', path: '/fragment', h1: 'Fragment sessiyasi', ready: 'Sessiya faol' },
  { name: 'queues', path: '/queues', h1: 'Navbatlar', ready: 'fulfill-order' },
  { name: 'audit', path: '/audit', h1: 'Audit log', ready: 'ORDER_REFUND' },
  { name: 'admins', path: '/admins', h1: 'Adminlar', ready: 'Malika R.' },
];

for (const theme of ['light', 'dark'] as ThemeName[]) {
  test.describe(`screens, ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await chooseTheme(page, theme);
      await seedMock(page, { signedIn: true, role: 'OWNER' });
    });

    for (const screen of SCREENS) {
      test(`${screen.name} opens with its data`, async ({ page }, testInfo) => {
        await page.goto(screen.path);
        await expect(page.getByRole('heading', { level: 1, name: screen.h1 })).toBeVisible();
        // Visible text only: filter selects also list enum values as hidden <option>s.
        await expect(page.getByText(screen.ready).filter({ visible: true }).first()).toBeVisible();
        // No sideways page scroll at either width: wide tables scroll inside their card.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        await page.screenshot({
          path: shotPath(`s5-${screen.name}-${testInfo.project.name}-${theme}`),
          fullPage: true,
        });
      });
    }

    test('drawers: payment review and audit diff', async ({ page }, testInfo) => {
      await page.goto('/payments?review=mkrev000003');
      const review = page.getByRole('dialog', { name: 'To‘lov tekshiruvi' });
      await expect(review.getByText('<b>Diqqat</b>', { exact: false })).toBeVisible();
      await page.screenshot({
        path: shotPath(`s5-drawer-review-${testInfo.project.name}-${theme}`),
      });
      await page.keyboard.press('Escape');
      await expect(page).not.toHaveURL(/review=/);

      await page.goto('/audit?entry=mkaud000001');
      const audit = page.getByRole('dialog', { name: 'ORDER_REFUND' });
      await expect(audit.getByText('+ status: "REFUNDED"')).toBeVisible();
      await page.screenshot({
        path: shotPath(`s5-drawer-audit-${testInfo.project.name}-${theme}`),
      });
    });
  });
}
