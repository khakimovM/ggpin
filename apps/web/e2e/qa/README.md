# e2e/qa: phase 7 S11 quality sweeps

Two parts, by cost.

## In the ordinary suite (`npx playwright test`)

Cheap, and they catch regressions nothing else sees. They run in the `w375`, `w768` and `w1440`
projects only (the config keeps `e2e/qa/` out of `mobile-390`):

- `a11y-targets.spec.ts`: the pressable area of every control on every screen is at least 44 x 44 in
  a touch context (the Mini App, a web viewport under 768 px) and 24 x 24 on a desktop viewport, no
  two areas overlap, and nothing covers a hit area. The area is the element plus its invisible
  hit-area pseudo-element (`HIT_AREA_*` in `packages/ui/src/lib/styles.ts`), clipped by the overflow
  of its ancestors and hit-tested (`qa-targets.ts`). The drawn size of a control is the design's.
- `a11y-targets-tablet.spec.ts` (`w1440` project only): the same at 1024 px with a coarse pointer,
  where the CSS turns `--hit-min` to 44 px (`globals.css`).
- `a11y-keyboard.spec.ts`: the whole web purchase with the keyboard only.

### Known, accepted gap

The promo dots (web catalog, from 768 px) sit on the design's 24 px pitch. A 44 px wide area would
take the neighbour's taps, so their area is 44 high and 24 wide (`data-hit="y"`,
`HIT_AREA_44_Y`). That meets WCAG 2.2 AA 2.5.8; on a coarse pointer at 768 px and wider it is not
44 x 44. The carousel also changes slide by itself and by swipe.

## Heavy sweeps, QA config only

`playwright.qa.config.ts` reuses the main configuration (same server and width projects) and runs
only `matrix.spec.ts` and `a11y-focus-motion.spec.ts`:

```bash
cd apps/web
npx playwright test -c playwright.qa.config.ts --workers=2
# with screenshots (written outside the repo) and axe notes:
QA_SHOTS_DIR=/some/dir npx playwright test -c playwright.qa.config.ts --workers=2
```

- `matrix.spec.ts`: every screen x 375 / 768 / 1440 x light / dark x uz / ru (about 400 cells), one
  screenshot and one axe scan (WCAG 2.0 / 2.1 A and AA; critical and serious findings fail) and a
  sideways-overflow check per cell.
- `a11y-focus-motion.spec.ts`: no looping animation under `prefers-reduced-motion`, and a visible
  focus ring on the first 40 Tab stops of every screen.

## The production build check

`node scripts/prod-build-check.mjs` (from `apps/web`) builds with `NODE_ENV=production`: the mock API
guard must refuse `NEXT_PUBLIC_API_MOCKS`, and no mock code may be in `.next`. It rebuilds `.next`,
so run it when no e2e server is using that build.
