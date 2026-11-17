import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type UserConfig } from 'vite';
import { MOCKS_IN_PRODUCTION_MESSAGE, parseAdminEnv } from './src/env-schema';

// The folder of this file: the guard and Vite itself read the same `.env` files, whatever the
// working directory of the build is.
const configDir = path.dirname(fileURLToPath(import.meta.url));

export const NODE_ENV_IN_BUILD_MESSAGE =
  'NODE_ENV must be "production" (or unset) for an admin build: a development build ships React in development mode';

/**
 * A development build (React dev mode, `import.meta.env.DEV` true) would also keep the dev-only
 * mock loader and theme probe in the bundle. Vite makes one when NODE_ENV=development is set in
 * the process, or in a `.env` file (which `loadEnv` reports as VITE_USER_NODE_ENV).
 */
function assertProductionNodeEnv(): void {
  for (const value of [process.env.NODE_ENV, process.env.VITE_USER_NODE_ENV]) {
    if (value !== undefined && value !== 'production') {
      throw new Error(NODE_ENV_IN_BUILD_MESSAGE);
    }
  }
}

export default defineConfig(({ command, mode }): UserConfig => {
  if (command === 'build') {
    const raw = loadEnv(mode, configDir, 'VITE_');
    assertProductionNodeEnv();
    // Every `vite build` is a production build: mocks exist only on the dev server. Checked here,
    // before anything is compiled, so a bad build cannot produce a bundle at all.
    if ((raw.VITE_API_MOCKS ?? '').trim() !== '') throw new Error(MOCKS_IN_PRODUCTION_MESSAGE);
    parseAdminEnv(raw, { production: true });
  }
  return {
    plugins: [react()],
    envDir: configDir,
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
