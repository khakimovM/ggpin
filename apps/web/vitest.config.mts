import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    // next-intl's ESM build imports 'next/server' without an extension; inlining lets Vite resolve it.
    server: { deps: { inline: ['next-intl'] } },
  },
});
