import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: [['text', { skipFull: false }]],
      // Report only the money-critical modules; thresholds fail `vitest run` when they slip.
      include: ['src/money.ts', 'src/order-state.ts'],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
