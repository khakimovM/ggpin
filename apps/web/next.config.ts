import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import createNextIntlPlugin from 'next-intl/plugin';
import { parseClientEnv } from './src/env-schema';
import { assertNoMocksInProduction, isProductionRun } from './src/mock-guard';
import { buildHeaderRules } from './src/security-headers';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default function config(phase: string): NextConfig {
  // Only the API origin is needed here (CSP); the strict checks (required values, https) live in
  // src/env.ts and run when the app code is built.
  const env = parseClientEnv(
    {
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
      NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
      NEXT_PUBLIC_BOT_USERNAME: process.env.NEXT_PUBLIC_BOT_USERNAME,
      NEXT_PUBLIC_API_MOCKS: process.env.NEXT_PUBLIC_API_MOCKS,
      NEXT_PUBLIC_SUPPORT_URL: process.env.NEXT_PUBLIC_SUPPORT_URL,
    },
    { production: false },
  );
  // Mocks are refused here, in the config itself, so no page or layout has to import env.ts first.
  // (isProductionRun explains why `next typegen` is not treated as a production run.)
  assertNoMocksInProduction({
    isProduction: isProductionRun(phase, process.argv),
    mocks: env.NEXT_PUBLIC_API_MOCKS,
  });
  const apiOrigin = new URL(env.NEXT_PUBLIC_API_URL).origin;

  const nextConfig: NextConfig = {
    reactStrictMode: true,
    poweredByHeader: false,
    // @repo/ui is consumed as TypeScript source (no build step).
    transpilePackages: ['@repo/ui'],
    // Imports from the @repo/ui barrel are rewritten to the single component modules used, so a
    // page does not pay for the whole component set (the package is marked side-effect free).
    experimental: { optimizePackageImports: ['@repo/ui'] },
    // Linting runs once, from the root flat config (`npm run lint`, CI), not again inside builds.
    eslint: { ignoreDuringBuilds: true },
    headers: () =>
      Promise.resolve(buildHeaderRules({ apiOrigin, isDev: phase === PHASE_DEVELOPMENT_SERVER })),
  };
  return withNextIntl(nextConfig);
}
