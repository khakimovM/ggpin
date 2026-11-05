import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

// The e2e app is built and started like production, with the real (non-mock) transport.
// These values are placeholders: tests never reach the API origin.
const APP_ENV = {
  NEXT_PUBLIC_API_URL: 'http://localhost:5000/api/v1',
  NEXT_PUBLIC_SITE_URL: BASE_URL,
  NEXT_PUBLIC_BOT_USERNAME: 'ggpin_bot',
  NEXT_PUBLIC_API_MOCKS: '',
  NEXT_PUBLIC_SUPPORT_URL: '',
  // Enables the token-probe fixture page; it is a 404 in every real build.
  E2E_PROBES: '1',
};

const desktopChrome = devices['Desktop Chrome'];
// Protocol-level specs run once, in the `http` project; rendering specs run per viewport.
const HTTP_SPECS = /http\.spec\.ts/;
// Behaviour that differs by layout: sheets are bottom sheets below 768px and modals from 768px.
const MOBILE_ONLY = /\.mobile\.spec\.ts/;
const DESKTOP_ONLY = /\.desktop\.spec\.ts/;

// WebKit (the Safari engine Telegram on iOS uses) runs the component gallery locally. CI installs
// chromium only, to keep that job small and fast; WebKit joins CI in phase 7 S12, when the full
// journeys run on it too, together with the browser download in the workflow cache key.
const webkitProject = {
  name: 'webkit-390',
  testMatch: /ui-gallery.*\.spec\.ts/,
  testIgnore: DESKTOP_ONLY,
  use: { ...devices['iPhone 14'], viewport: { width: 390, height: 844 } },
};

export default defineConfig({
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
    {
      name: 'mobile-390',
      testIgnore: [HTTP_SPECS, DESKTOP_ONLY],
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
    {
      name: 'w375',
      testIgnore: [HTTP_SPECS, DESKTOP_ONLY],
      use: { ...desktopChrome, viewport: { width: 375, height: 812 } },
    },
    {
      name: 'w768',
      testIgnore: [HTTP_SPECS, MOBILE_ONLY],
      use: { ...desktopChrome, viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'w1440',
      testIgnore: [HTTP_SPECS, MOBILE_ONLY],
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
