import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The tick, the spinner and the check on a --success or --info disc are drawn in --card: white in
// the light theme (--success/--info are mid-tone there) and the dark card colour in the dark theme,
// where those two colours are pale and white would be ~2:1. WCAG 1.4.11 asks 3:1 for such icons.

const css = readFileSync(
  path.resolve(__dirname, '../../../../../../packages/ui/tokens.css'),
  'utf8',
);
const block = (selector: string) => {
  const start = css.indexOf(selector);
  return css.slice(start, css.indexOf('}', start));
};
const THEMES = {
  light: block(':root,[data-theme="light"]{'),
  dark: block('[data-theme="dark"]{'),
};
const token = (theme: keyof typeof THEMES, name: string) => {
  const match = new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`).exec(THEMES[theme]);
  if (match?.[1] === undefined) throw new Error(`--${name} not found in ${theme}`);
  return match[1];
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('glyphs on --success and --info discs', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const disc of ['success', 'info'] as const) {
      it(`${theme}: --card on --${disc} is at least 3:1`, () => {
        expect(ratio(token(theme, 'card'), token(theme, disc))).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it('and white would not have been in the dark theme (why --card, not white)', () => {
    expect(ratio('#FFFFFF', token('dark', 'success'))).toBeLessThan(3);
    expect(ratio('#FFFFFF', token('dark', 'info'))).toBeLessThan(3);
  });

  it('no disc in the web app draws its glyph in white any more', () => {
    const files = [
      'features/order/OrderHero.tsx',
      'features/pay/PayFinal.tsx',
      'features/product/RecipientConfirmed.tsx',
      'features/topup/TopupWaiting.tsx',
    ];
    for (const file of files) {
      const source = readFileSync(path.resolve(__dirname, '../../../', file), 'utf8');
      expect(source, file).not.toMatch(
        /bg-(success|info)[^"`]*text-white|text-white[^"`]*bg-(success|info)/,
      );
    }
  });
});
