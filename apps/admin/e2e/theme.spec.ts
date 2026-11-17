import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chooseTheme } from './support/mock';

// Acceptance 5 of phase 9: the admin bundle gets the shared stylesheet. The computed colours of a
// danger Button and a premium Badge must be the tokens.css values, and differ between themes.

const TOKENS = readFileSync(
  fileURLToPath(new URL('../../../packages/ui/tokens.css', import.meta.url)),
  'utf8',
);

function block(selector: string): string {
  const start = TOKENS.indexOf(`${selector}{`);
  if (start === -1) throw new Error(`no ${selector} block in tokens.css`);
  return TOKENS.slice(start, TOKENS.indexOf('}', start));
}

function token(theme: 'light' | 'dark', name: string): string {
  const source = block(theme === 'light' ? ':root,[data-theme="light"]' : '[data-theme="dark"]');
  const hex = new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`).exec(source)?.[1];
  if (hex === undefined) throw new Error(`--${name} missing in the ${theme} block`);
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

// Button `danger` and Badge `premium` (packages/ui): which token paints what, per theme.
const EXPECTED = {
  light: {
    dangerBg: token('light', 'danger-hover'),
    dangerFg: token('light', 'danger-foreground'),
    premiumBg: token('light', 'premium-soft'),
    premiumFg: token('light', 'primary-soft-foreground'),
  },
  dark: {
    dangerBg: token('dark', 'danger'),
    dangerFg: token('dark', 'background'),
    premiumBg: token('dark', 'premium-soft'),
    premiumFg: token('dark', 'premium'),
  },
} as const;

for (const theme of ['light', 'dark'] as const) {
  test(`danger Button and premium Badge use the ${theme} tokens`, async ({ page }) => {
    await chooseTheme(page, theme);
    await page.goto('/dev/theme-probe');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const danger = page.getByTestId('probe-danger');
    const premium = page.getByTestId('probe-premium');
    await expect(danger).toHaveCSS('background-color', EXPECTED[theme].dangerBg);
    await expect(danger).toHaveCSS('color', EXPECTED[theme].dangerFg);
    await expect(premium).toHaveCSS('background-color', EXPECTED[theme].premiumBg);
    await expect(premium).toHaveCSS('color', EXPECTED[theme].premiumFg);
  });
}

test('the two themes really differ', () => {
  expect(EXPECTED.light.dangerBg).not.toBe(EXPECTED.dark.dangerBg);
  expect(EXPECTED.light.premiumBg).not.toBe(EXPECTED.dark.premiumBg);
  expect(EXPECTED.light.premiumFg).not.toBe(EXPECTED.dark.premiumFg);
});
