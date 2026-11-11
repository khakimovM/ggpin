import { test } from '@playwright/test';
import { shootAndScan } from './qa-support';
import { MINI, type Lang, type Scheme } from './screens-mini';
import { WEB } from './screens-web';

// Phase 7 S11: every screen x the project's width (375 / 768 / 1440) x light/dark x uz/ru. One
// screenshot (to $QA_SHOTS_DIR, outside the repo) and one axe scan per cell; critical/serious
// axe findings and sideways overflow fail the test. Only the QA config runs it (README.md): it is
// ~400 page loads, far too slow for the ordinary suite.

const LANGS: Lang[] = ['uz', 'ru'];
const SCHEMES: Scheme[] = ['light', 'dark'];

for (const [group, screens] of [
  ['Mini App', MINI],
  ['web', WEB],
] as const) {
  test.describe(group, () => {
    for (const screen of screens) {
      for (const lang of LANGS) {
        for (const scheme of SCHEMES) {
          test(`${screen.name} ${lang}/${scheme}`, async ({ page }, testInfo) => {
            await screen.open({ page, lang, scheme });
            await shootAndScan(page, testInfo, `${screen.name}-${lang}-${scheme}`);
          });
        }
      }
    }
  });
}
