import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { BRAND } from '@repo/shared';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { settle } from '../support/settle';

// The site shell (phase 8 S1): header, mobile menu, footer, language switch and the error page.
// The pages under test are the marketing home (`/`, `/ru`) and the two e2e-only pages that throw
// while rendering (see the `e2e-probe*` folders under app/[locale]).

export const LANGS = {
  uz: { copy: uz.site, path: '/', other: '/ru', wide: 1041, menu: 1040 },
  ru: { copy: ru.site, path: '/ru', other: '/', wide: 1181, menu: 1180 },
} as const;
export type Lang = keyof typeof LANGS;

export const brand = BRAND.name;
export const code = (lang: Lang) => lang.toUpperCase();
// The accessible name of a language link: the visible code, then the language's own name.
export const langName = (lang: Lang, copy: (typeof LANGS)[Lang]['copy']) =>
  `${code(lang)} — ${lang === 'uz' ? copy.nav.langUz : copy.nav.langRu}`;

// Opens a page and waits until it is ready to be driven: the styles apply (the header is sticky)
// and React has hydrated the menu button (a click before that is lost). A loaded machine makes
// both slower than "load".
export async function open(page: Page, path: string, width: number, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto(path);
  await page.waitForFunction(() => {
    const header = document.querySelector('header');
    const button = document.querySelector('header button');
    return (
      header !== null &&
      getComputedStyle(header).position === 'sticky' &&
      button !== null &&
      Object.keys(button).some((key) => key.startsWith('__reactProps'))
    );
  });
}
export const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el === null ? '' : (el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '');
  });

// Critical and serious findings of the WCAG A/AA rules, as `id: first target`.
export async function seriousViolations(page: Page): Promise<string[]> {
  await settle(page);
  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return scan.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`);
}

// Where the right-most control of the header ends: nothing may be pushed out of the viewport.
export const headerRight = (page: Page) =>
  page.evaluate(() => {
    const controls = document.querySelectorAll('header a, header button');
    let right = 0;
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      if (box.width > 0) right = Math.max(right, box.right);
    }
    return { right, viewport: window.innerWidth };
  });
