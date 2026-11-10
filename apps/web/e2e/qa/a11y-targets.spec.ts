import { expect, test, type TestInfo } from '@playwright/test';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { QA_DIR, settle } from './qa-support';
import { DESKTOP_MIN, TOUCH_BELOW, TOUCH_MIN, targetProblems } from './qa-targets';
import { MINI, type Lang, type Scheme } from './screens-mini';
import { WEB } from './screens-web';

// Phase 7 S11, check 3 (continued), on every screen of the matrix. It runs in the ordinary suite,
// in the w375 / w768 / w1440 projects (the config keeps it out of the 390 ones), because it is
// cheap and catches a regression no other spec sees:
//  - pressable area (WCAG 2.2 AA 2.5.8 and the owner's 44 px rule): the EFFECTIVE area of every
//    control, its box together with its transparent hit-area pseudo-element (clipped by the
//    overflow of its ancestors, and hit-tested, see qa-targets.ts), is >= 44 x 44 in a touch
//    context (the Mini App, a web viewport under 768 px, a coarse pointer) and >= 24 x 24 on a
//    desktop viewport. The drawn size stays the design's. A link inside a running sentence is
//    exempt.
//  - the effective areas of two controls never overlap, so a tap never goes to the neighbour, and
//    nothing else covers a hit area.
//
// Known, accepted gap: the promo dots (web catalog, from 768 px) sit on the design's 24 px pitch, so
// their area is 44 high and 24 wide (data-hit="y"); on a coarse pointer at >= 768 px that is
// WCAG 2.5.8 AA but not 44 x 44. See README.md.
// Offenders are listed in the failure message and in $QA_SHOTS_DIR/target-notes.jsonl.

const COMBOS: Array<[Lang, Scheme]> = [
  ['uz', 'light'],
  ['ru', 'dark'],
];

async function note(testInfo: TestInfo, rows: object[]) {
  if (QA_DIR === '' || rows.length === 0) return;
  await mkdir(QA_DIR, { recursive: true });
  const lines = rows.map((row) => JSON.stringify({ project: testInfo.project.name, ...row }));
  await appendFile(path.join(QA_DIR, 'target-notes.jsonl'), `${lines.join('\n')}\n`);
}

for (const [group, screens] of [
  ['Mini App', MINI],
  ['web', WEB],
] as const) {
  test.describe(`${group}: pressable area >= ${TOUCH_MIN} (touch) / ${DESKTOP_MIN} (desktop)`, () => {
    for (const screen of screens) {
      for (const [lang, scheme] of COMBOS) {
        test(`${screen.name} ${lang}/${scheme}`, async ({ page }, testInfo) => {
          const width = testInfo.project.use.viewport?.width ?? 0;
          const touch = group === 'Mini App' || width < TOUCH_BELOW;
          await screen.open({ page, lang, scheme });
          await settle(page);
          const { small, overlaps, covered } = await targetProblems(
            page,
            touch ? TOUCH_MIN : DESKTOP_MIN,
          );
          await note(testInfo, [
            ...small.map((x) => ({ screen: screen.name, lang, scheme, kind: 'small', ...x })),
            ...overlaps.map((what) => ({
              screen: screen.name,
              lang,
              scheme,
              kind: 'overlap',
              what,
            })),
            ...covered.map((what) => ({
              screen: screen.name,
              lang,
              scheme,
              kind: 'covered',
              what,
            })),
          ]);
          expect(small.map((x) => `${x.what} ${x.width}x${x.height}`)).toEqual([]);
          expect(overlaps).toEqual([]);
          expect(covered).toEqual([]);
        });
      }
    }
  });
}
