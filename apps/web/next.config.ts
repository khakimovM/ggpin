import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import createNextIntlPlugin from 'next-intl/plugin';
import { parseClientEnv } from './src/env-schema';
import { assertNoMocksInProduction, isProductionRun } from './src/mock-guard';
import { buildHeaderRules } from './src/security-headers';
import { parseServerEnv } from './src/server-env';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default function config(phase: string): NextConfig {
  // The mock guard needs the env here (and parsing it checks every format, the analytics id
  // included); the strict checks (required values, https) live in src/env.ts and run when the app
  // code is built.
  const env = parseClientEnv(
    {
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
      NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
      NEXT_PUBLIC_BOT_USERNAME: process.env.NEXT_PUBLIC_BOT_USERNAME,
      NEXT_PUBLIC_API_MOCKS: process.env.NEXT_PUBLIC_API_MOCKS,
      NEXT_PUBLIC_SUPPORT_URL: process.env.NEXT_PUBLIC_SUPPORT_URL,
      NEXT_PUBLIC_TELEGRAM_CHANNEL_URL: process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL_URL,
      // Checked here too, so a malformed id stops `next build` before any page is compiled.
      NEXT_PUBLIC_ANALYTICS_SITE_ID: process.env.NEXT_PUBLIC_ANALYTICS_SITE_ID,
    },
    { production: false },
  );
  // Mocks are refused here, in the config itself, so no page or layout has to import env.ts first.
  // (isProductionRun explains why `next typegen` is not treated as a production run.)
  assertNoMocksInProduction({
    isProduction: isProductionRun(phase, process.argv),
    mocks: env.NEXT_PUBLIC_API_MOCKS,
  });

  // The server-only API URL is checked at start-up too, so a typo fails the deploy instead of
  // silently turning every server-rendered price off.
  parseServerEnv({ API_INTERNAL_URL: process.env.API_INTERNAL_URL });

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
    // Next.js streams a page's metadata AFTER the first chunk of the body (the <title> and the meta
    // tags land in <body>) for every client it does not know as a crawler. Lighthouse reads only
    // <head> for its meta-description audit, and some link-preview fetchers read no further than the
    // head. Matching every user agent makes the metadata part of <head> for everyone; the landing's
    // metadata is built from texts (no API call), so nothing is waited for.
    // RULE: `generateMetadata` never goes to the network or to the API: metadata comes from i18n and
    // static data only. With this setting the first byte waits for the metadata, so a fetch there
    // would delay every visitor's TTFB (a unit test guards it: metadata-no-network.test.ts).
    htmlLimitedBots: /.*/,
    headers: () => Promise.resolve(buildHeaderRules({ isDev: phase === PHASE_DEVELOPMENT_SERVER })),
  };
  return withNextIntl(nextConfig);
}
