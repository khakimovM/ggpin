import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LANGS, SECTIONS, THEMES, openGallery, watchPage } from './support/gallery';

// Component gallery (/dev/ui): every @repo/ui component in both themes and both sample
// languages, in every viewport project (375 / 390 / 768 / 1440) and in WebKit locally.
// Screenshots go to test-results/gallery for visual comparison with design/handoff; they are
// artefacts, not committed baselines (fonts and rasterisation differ per OS).
// Behaviour checks live in ui-gallery-behaviour.spec.ts.

const SHOTS_DIR = join('test-results', 'gallery');

test.describe('gallery renders', () => {
  for (const theme of THEMES) {
    for (const lang of LANGS) {
      test(`${theme} · ${lang}: all sections, no console or CSP errors, screenshots`, async ({
        page,
      }, testInfo) => {
        // Seven full-resolution screenshots per run; WebKit rasterises them slowly.
        test.setTimeout(90_000);
        const problems = watchPage(page);
        await page.addInitScript(() => {
          const store = window as unknown as { __csp?: string[] };
          store.__csp = [];
          document.addEventListener('securitypolicyviolation', (event) => {
            store.__csp?.push(`${event.violatedDirective} ${event.blockedURI}`);
          });
        });
        await openGallery(page, theme, lang);

        for (const id of SECTIONS)
          await expect(page.locator(`[data-section="${id}"]`)).toBeVisible();

        // No horizontal scroll: Russian copy must wrap, not push the layout wider than the screen.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);

        mkdirSync(SHOTS_DIR, { recursive: true });
        const name = `${testInfo.project.name}-${theme}-${lang}`;
        await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), fullPage: true });
        for (const id of SECTIONS) {
          await page
            .locator(`[data-section="${id}"]`)
            .screenshot({ path: join(SHOTS_DIR, `${name}-${id}.png`) });
        }

        const violations = await page.evaluate(
          () => (window as unknown as { __csp?: string[] }).__csp ?? [],
        );
        expect(violations).toEqual([]);
        expect(problems).toEqual([]);
      });
    }
  }
});

test.describe('gallery accessibility (axe, WCAG AA contrast included)', () => {
  for (const theme of THEMES) {
    for (const lang of LANGS) {
      test(`${theme} · ${lang}`, async ({ page }) => {
        await openGallery(page, theme, lang);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        expect(
          results.violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 4),
          })),
        ).toEqual([]);
      });
    }
  }
});
