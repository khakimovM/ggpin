// Starts and stops what the Lighthouse run measures: the fixture catalog API (the site's server
// reads it, like in the e2e runs) and the production build of the site on its own port.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const WEB_DIR = resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);

export const SITE_PORT = 3200;
export const CATALOG_PORT = 5100;
export const SITE_ORIGIN = `http://localhost:${SITE_PORT}`;
const CATALOG_ORIGIN = `http://localhost:${CATALOG_PORT}`;

/** Env of the production build and server: same shape as playwright.config.ts, other port. */
export const SITE_ENV = {
  NEXT_PUBLIC_API_URL: 'http://localhost:5000/api/v1',
  NEXT_PUBLIC_SITE_URL: SITE_ORIGIN,
  NEXT_PUBLIC_BOT_USERNAME: 'ggpin_bot',
  NEXT_PUBLIC_API_MOCKS: '',
  NEXT_PUBLIC_SUPPORT_URL: '',
  NEXT_PUBLIC_TELEGRAM_CHANNEL_URL: 'https://t.me/ggpin_e2e_channel',
  API_INTERNAL_URL: `${CATALOG_ORIGIN}/api/v1`,
  NEXT_TELEMETRY_DISABLED: '1',
};

const NEXT_BIN = require.resolve('next/dist/bin/next');

const BUILD_ID_FILE = resolve(WEB_DIR, '.next', 'BUILD_ID');
// Written after our own build: the env it was made with and the build it belongs to. Any other
// build over it (the Playwright one on :3100 with E2E_PROBES, a plain `next build`) changes the
// BUILD_ID, so a stale or foreign build is never measured by accident.
const MARKER_FILE = resolve(WEB_DIR, '.next', 'lighthouse-env.json');

function buildId() {
  return existsSync(BUILD_ID_FILE) ? readFileSync(BUILD_ID_FILE, 'utf8').trim() : null;
}

/** True when .next is the build `--build` made with the current Lighthouse env. */
export function hasLighthouseBuild() {
  if (!existsSync(MARKER_FILE)) return false;
  try {
    const marker = JSON.parse(readFileSync(MARKER_FILE, 'utf8'));
    return (
      marker.buildId === buildId() &&
      marker.buildId !== null &&
      JSON.stringify(marker.env) === JSON.stringify(SITE_ENV)
    );
  } catch {
    return false;
  }
}

/** `next build` with the Lighthouse env (the public URLs are inlined at build time). */
export function buildSite() {
  const result = spawnSync(process.execPath, [NEXT_BIN, 'build'], {
    cwd: WEB_DIR,
    env: { ...process.env, ...SITE_ENV },
    stdio: 'inherit',
  });
  if (result.status !== 0) return false;
  writeFileSync(MARKER_FILE, JSON.stringify({ buildId: buildId(), env: SITE_ENV }));
  return true;
}

async function answers(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: 'manual' });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function waitFor(url, label, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early (code ${child.exitCode})`);
    if (await answers(url)) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${label} did not answer ${url} within ${timeoutMs / 1000}s`);
}

function stop(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    // The process tree: `next start` can have children that outlive a plain kill.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

/** Starts both servers; returns a function that stops what this call started. */
export async function startServers() {
  const started = [];
  const stopAll = () => started.forEach(stop);
  try {
    if (await answers(`${SITE_ORIGIN}/`)) {
      throw new Error(`port ${SITE_PORT} is already in use: stop that server first`);
    }
    if (!(await answers(`${CATALOG_ORIGIN}/health`))) {
      const catalog = spawn(
        process.execPath,
        ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'e2e/support/catalog-server.ts'],
        {
          cwd: WEB_DIR,
          env: { ...process.env, FIXTURE_CATALOG_PORT: String(CATALOG_PORT) },
          stdio: 'inherit',
        },
      );
      started.push(catalog);
      await waitFor(`${CATALOG_ORIGIN}/health`, 'fixture catalog server', catalog);
    }
    const site = spawn(process.execPath, [NEXT_BIN, 'start', '--port', String(SITE_PORT)], {
      cwd: WEB_DIR,
      env: { ...process.env, ...SITE_ENV, NODE_ENV: 'production' },
      stdio: 'inherit',
    });
    started.push(site);
    await waitFor(`${SITE_ORIGIN}/`, 'next start', site);
  } catch (error) {
    stopAll();
    throw error;
  }
  return stopAll;
}
