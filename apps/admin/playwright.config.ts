import { defineConfig, devices } from '@playwright/test';

// The admin journeys run against the Vite dev server with the in-browser mock API (the only place
// mocks are allowed: a production build refuses them). Port 5183, not the dev 5173, so a running
// `npm run dev` never collides with a test run.
const PORT = 5183;
const BASE_URL = `http://localhost:${PORT}`;

const desktopChrome = devices['Desktop Chrome'];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'w1440', use: { ...desktopChrome, viewport: { width: 1440, height: 900 } } },
    { name: 'w768', use: { ...desktopChrome, viewport: { width: 768, height: 1024 } } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    env: {
      VITE_API_URL: 'http://localhost:5000/api/v1',
      VITE_ENV_LABEL: 'STAGING',
      VITE_API_MOCKS:
        'auth,confirmations,dashboard,orders,users,payments,catalog,settings,queues,wallet,fragment,audit,admins',
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
