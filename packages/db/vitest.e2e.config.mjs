import { defineConfig } from 'vitest/config';

// Real Postgres. All files share one database, so they run strictly one at a time.
export default defineConfig({
  test: {
    include: ['test/**/*.e2e.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
