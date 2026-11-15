import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { settle } from '../support/settle';

// Phase 7 S11 QA helpers: every screen is photographed (when QA_SHOTS_DIR is set) and scanned with
// axe. critical and serious findings fail the test; lesser ones are only written to a notes file
// for the report, because they are the owner's call, not a regression.

export const QA_DIR = process.env.QA_SHOTS_DIR ?? '';

export interface Finding {
  id: string;
  impact: string | null | undefined;
  target: string;
  help: string;
}

export async function scan(page: Page, extra: string[] = []): Promise<Finding[]> {
  await settle(page);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', ...extra])
    .analyze();
  return result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    target: violation.nodes[0]?.target.join(' ') ?? '',
    help: violation.help,
  }));
}

export const isBlocking = (finding: Finding) =>
  finding.impact === 'critical' || finding.impact === 'serious';

/** One shot (full page, tall window so fixed bars sit at the end) + the axe scan of the same state. */
export async function shootAndScan(page: Page, testInfo: TestInfo, name: string) {
  await settle(page);
  const size = page.viewportSize();
  if (QA_DIR !== '' && size !== null) {
    await mkdir(QA_DIR, { recursive: true });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height > size.height) {
      await page.setViewportSize({ width: size.width, height: Math.min(height, 4000) });
    }
    await page.screenshot({
      path: path.join(QA_DIR, `${size.width}-${name}.png`),
      animations: 'disabled',
    });
    if (height > size.height) await page.setViewportSize(size);
  }
  const findings = await scan(page, ['best-practice']);
  if (QA_DIR !== '') {
    const rows = findings.map((f) =>
      JSON.stringify({ project: testInfo.project.name, name, ...f }),
    );
    if (rows.length > 0)
      await appendFile(path.join(QA_DIR, 'axe-notes.jsonl'), `${rows.join('\n')}\n`);
  }
  expect(
    findings.filter(isBlocking).map((f) => `${f.id}: ${f.target}`),
    `axe critical/serious on ${name}`,
  ).toEqual([]);
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(sideways, `horizontal overflow on ${name}`).toBeLessThanOrEqual(0);
}

/** Every focus stop must show where it is: an outline or a ring (box-shadow) on :focus-visible. */
export async function focusIsVisible(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return null;
    const style = getComputedStyle(el);
    const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
    const ring = style.boxShadow !== 'none';
    // A control inside a styled label (radio cards) may carry the ring on its parent.
    const parent = el.closest('label, [role="radio"], [data-focus-ring]');
    const parentStyle = parent === null ? null : getComputedStyle(parent);
    const parentRing =
      parentStyle !== null &&
      (parentStyle.boxShadow !== 'none' ||
        (parentStyle.outlineStyle !== 'none' && Number.parseFloat(parentStyle.outlineWidth) > 0));
    return outline || ring || parentRing
      ? null
      : `${el.tagName.toLowerCase()} ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}`;
  });
}
