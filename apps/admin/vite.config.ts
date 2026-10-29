import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // @repo/shared is a linked workspace package compiled to CommonJS (for NestJS). Vite serves
  // linked packages as raw ESM in dev unless they are pre-bundled, so named imports would fail.
  optimizeDeps: { include: ['@repo/shared'] },
});
