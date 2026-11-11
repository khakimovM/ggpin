import { defineConfig, devices } from '@playwright/test';
import { E2E_BOT_USERNAME } from './e2e/support/app-env';

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

// The e2e app is built and started like production, with the real (non-mock) transport.
// The API origin is the one the browser is allowed to call (CSP connect-src). Most tests answer it
// with `page.route` fakes and never reach a server; only the `real-api` project (journey 4) starts
// the real API on this port.
const APP_ENV = {
  NEXT_PUBLIC_API_URL: 'http://localhost:5000/api/v1',
  NEXT_PUBLIC_SITE_URL: BASE_URL,
  NEXT_PUBLIC_BOT_USERNAME: E2E_BOT_USERNAME,
  NEXT_PUBLIC_API_MOCKS: '',
  NEXT_PUBLIC_SUPPORT_URL: '',
  // Enables the token-probe fixture page; it is a 404 in every real build.
  E2E_PROBES: '1',
  // No call home from the build.
  NEXT_TELEMETRY_DISABLED: '1',
};

const desktopChrome = devices['Desktop Chrome'];
// Protocol-level specs run once, in the `http` project; rendering specs run per viewport.
const HTTP_SPECS = /http\.spec\.ts/;
// Behaviour that differs by layout: sheets are bottom sheets below 768px and modals from 768px.
const MOBILE_ONLY = /\.mobile\.spec\.ts/;
const DESKTOP_ONLY = /\.desktop\.spec\.ts/;
// Journeys that run against the real API (its own database, Redis DB and port 5000), and since
// phase 7 S12-a the real worker too. They start those themselves, take turns on the one stack
// (e2e/support/real-lock.ts), so they run once, in their own project, never in the viewport ones.
const REAL_API_SPECS = /(?:j4-referral|j5-topup|contract-[\w-]+)\.(?:real\.)?spec\.ts/;
// The S11 QA specs (e2e/qa). The cheap ones run in the ordinary suite, in the three width projects
// only: a11y-targets (the pressable area of every control) and a11y-keyboard. The heavy sweeps (the
// 396-cell screenshot matrix, focus and motion on every screen) run only with
// playwright.qa.config.ts, and the tablet check (coarse pointer at 1024 px) in w1440 only.
export const QA_ALL = /e2e[\\/]qa[\\/]/;
export const QA_HEAVY = /e2e[\\/]qa[\\/](?:matrix|a11y-focus-motion)\.spec\.ts/;
const QA_TABLET = /e2e[\\/]qa[\\/]a11y-targets-tablet\.spec\.ts/;

// WebKit (the Safari engine Telegram on iOS uses) runs the component gallery locally. CI installs
// chromium only, to keep that job small and fast (the public pay page, which people open in
// Safari from the Mini App, runs on WebKit too); WebKit joins CI in phase 7 S12, when the full
// journeys run on it too, together with the browser download in the workflow cache key.
const webkitProject = {
  name: 'webkit-390',
  testMatch: /(?:ui-gallery.*|pay-page|pay-ends)\.spec\.ts/,
  testIgnore: DESKTOP_ONLY,
  use: { ...devices['iPhone 14'], viewport: { width: 390, height: 844 } },
};

const config = defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    // Traces can contain cookies/tokens, so they are kept only for failed tests.
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'http', testMatch: HTTP_SPECS },
    // Creates and migrates the database of the real-API journeys, once, and only when that
    // project runs: the viewport projects fake the API and need neither Postgres nor Redis.
    { name: 'real-api-setup', testMatch: /real-api\.setup\.ts/ },
    {
      name: 'real-api',
      testMatch: REAL_API_SPECS,
      dependencies: ['real-api-setup'],
      // One real stack (API port 5000, one database, Redis DB 13): the spec files take turns. The
      // lock in e2e/support/real-lock.ts is the second line; with one worker no file waits for it.
      workers: 1,
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 },
        // The real journeys carry real session and pay tokens (headers, URLs): no trace of them is
        // kept, and a screenshot is pixels only.
        trace: 'off',
        screenshot: 'only-on-failure',
      },
    },
    {
      name: 'mobile-390',
      testIgnore: [HTTP_SPECS, REAL_API_SPECS, DESKTOP_ONLY, QA_ALL],
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
    {
      name: 'w375',
      testIgnore: [HTTP_SPECS, REAL_API_SPECS, DESKTOP_ONLY, QA_HEAVY, QA_TABLET],
      use: { ...desktopChrome, viewport: { width: 375, height: 812 } },
    },
    {
      name: 'w768',
      testIgnore: [HTTP_SPECS, REAL_API_SPECS, MOBILE_ONLY, QA_HEAVY, QA_TABLET],
      use: { ...desktopChrome, viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'w1440',
      testIgnore: [HTTP_SPECS, REAL_API_SPECS, MOBILE_ONLY, QA_HEAVY],
      use: { ...desktopChrome, viewport: { width: 1440, height: 900 } },
    },
    ...(process.env.CI ? [] : [webkitProject]),
  ],
  webServer: {
    command: `npm run build && npx next start --port ${PORT}`,
    url: BASE_URL,
    env: APP_ENV,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});

export default config;
