import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type UserConfig } from 'vite';
import { MOCKS_IN_PRODUCTION_MESSAGE, parseAdminEnv } from './src/env-schema';

export default defineConfig(({ command, mode }): UserConfig => {
  if (command === 'build') {
    const raw = loadEnv(mode, process.cwd(), 'VITE_');
    // Every `vite build` is a production build: mocks exist only on the dev server. Checked here,
    // before anything is compiled, so a bad build cannot produce a bundle at all.
    if ((raw.VITE_API_MOCKS ?? '').trim() !== '') throw new Error(MOCKS_IN_PRODUCTION_MESSAGE);
    parseAdminEnv(raw, { production: true });
  }
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    // @repo/shared is a linked workspace package compiled to CommonJS (for NestJS). Vite serves
    // linked packages as raw ESM in dev unless they are pre-bundled, so named imports would fail.
    optimizeDeps: { include: ['@repo/shared'] },
    build: {
      // Source maps would publish the whole admin source next to the bundle.
      sourcemap: false,
    },
  };
});
