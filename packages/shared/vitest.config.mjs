import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: [['text', { skipFull: false }]],
      // Report only the money-critical modules; thresholds fail `vitest run` when they slip.
      include: [
        'src/money.ts',
        'src/money-pricing.ts',
        'src/money-schemas.ts',
        'src/catalog/*.ts',
        'src/pricing/*.ts',
        'src/order-state.ts',
        'src/env-secrets.ts',
        'src/job-enqueue.ts',
        'src/auth/*.ts',
        'src/tg-outbox.ts',
        'src/common-schemas.ts',
        'src/notify.ts',
        'src/payments/*.ts',
        'src/wallet/*.ts',
        'src/orders/*.ts',
        'src/fulfillment/*.ts',
        'src/log-redaction/**/*.ts',
      ],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
