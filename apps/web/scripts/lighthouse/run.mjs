// Lighthouse gate for the website (phase 8): every public page, in Uzbek and Russian, on the
// mobile and the desktop preset, 3 runs each, the median decides. Performance and accessibility
// must reach 90 everywhere, SEO on every indexable page; best practices is only reported.
//
//   npm run build -w web (with the env below)   -> or pass --build to do it here
//   npm run lighthouse -w web
//
// The site is the PRODUCTION build served by `next start -p 3200`, reading the catalog from the
// fixture server (port 5100). Chrome is the Playwright Chromium: no browser is downloaded.
// Reports (JSON + HTML of the median run) go to apps/web/lighthouse-report/.
import { chromium } from '@playwright/test';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { failures, medianIndex, printTable, summarise } from './report.mjs';
import { buildSite, hasLighthouseBuild, startServers } from './servers.mjs';
import { lighthouseTargets } from './urls.mjs';

const RUNS = 3;
const OUT_DIR = resolve(import.meta.dirname, '..', '..', 'lighthouse-report');
const FORM_FACTORS = [
  { name: 'mobile', config: undefined },
  { name: 'desktop', config: desktopConfig },
];

const slugOf = (path) => (path === '/' ? 'home' : path.replace(/^\//, '').replaceAll('/', '_'));

async function warmUp(urls) {
  // The first hit of a route compiles nothing in a production build, but it fills the data cache
  // (the catalog fetch): measure the steady state, not the cold start.
  for (const url of urls) await fetch(url).then((res) => res.text());
}

async function measure(chrome, target, formFactor) {
  const runs = [];
  for (let i = 0; i < RUNS; i += 1) {
    const result = await lighthouse(
      target.url,
      {
        port: chrome.port,
        logLevel: 'error',
        output: ['json', 'html'],
        onlyCategories: ['performance', 'accessibility', 'seo', 'best-practices'],
      },
      formFactor.config,
    );
    if (!result || result.lhr.runtimeError) {
      throw new Error(`${target.url} (${formFactor.name}): ${result?.lhr.runtimeError?.message}`);
    }
    runs.push(result);
  }
  const row = summarise(
    target,
    formFactor.name,
    runs.map((run) => run.lhr),
  );
  // Keep the report of the run whose performance is the median one.
  const scores = runs.map((run) => run.lhr.categories.performance?.score ?? 0);
  const keep = runs[medianIndex(scores)];
  const base = resolve(OUT_DIR, `${target.locale}-${slugOf(target.path)}-${formFactor.name}`);
  const [json, html] = keep.report;
  writeFileSync(`${base}.json`, json);
  writeFileSync(`${base}.html`, html);
  return row;
}

async function main() {
  if (process.argv.includes('--build')) {
    if (!buildSite()) throw new Error('next build failed');
  } else if (!hasLighthouseBuild()) {
    console.error(
      'apps/web/.next is not a Lighthouse build (missing, stale, or made by another command such ' +
        'as the Playwright build). Run `npm run lighthouse -w web -- --build`.',
    );
    process.exit(1);
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const targets = lighthouseTargets();
  const stopServers = await startServers();
  const rows = [];
  let chrome;
  try {
    chrome = await launch({
      chromePath: chromium.executablePath(),
      chromeFlags: ['--headless=new', '--disable-gpu', ...(process.env.CI ? ['--no-sandbox'] : [])],
      logLevel: 'silent',
    });
    await warmUp(targets.map((target) => target.url));
    for (const formFactor of FORM_FACTORS) {
      for (const target of targets) {
        console.log(`measuring ${target.path} (${formFactor.name}) x${RUNS}`);
        rows.push(await measure(chrome, target, formFactor));
      }
    }
  } finally {
    try {
      chrome?.kill();
    } catch {
      // Windows can refuse to kill an already-exited Chrome; nothing to clean then.
    }
    stopServers();
  }

  writeFileSync(resolve(OUT_DIR, 'summary.json'), JSON.stringify(rows, null, 2));
  printTable(rows);
  const failed = rows.filter((row) => failures(row).length > 0);
  if (failed.length > 0) {
    console.error(`Lighthouse gate failed on ${failed.length} of ${rows.length} measurements.`);
    process.exit(1);
  }
  console.log(`Lighthouse gate passed: ${rows.length} measurements, all >= 90.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
