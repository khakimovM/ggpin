import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';

/** Writes a screenshot named `<width>-<name>.png` into `dir` (QA material, not an assertion). */
export async function saveShot(
  page: Page,
  dir: string,
  name: string,
  { fullPage = true }: { fullPage?: boolean } = {},
) {
  const width = page.viewportSize()?.width ?? 0;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${width}-${name}.png`), fullPage });
}
