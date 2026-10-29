import { defineConfig } from 'vitest/config';

// Unit tests only: nothing here may need a database (`npm run verify` stays DB-free).
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
