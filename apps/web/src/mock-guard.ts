// The mock API (phase 7) must never reach a production build: a mocked wallet shows money that
// does not exist. This is checked in `next.config.ts` itself, so a bad build stops before any
// page is compiled, and does not depend on which layout happens to import `env.ts`.

// Next's phase names (next/constants); spelled out so this module stays free of Next imports.
const PHASE_PRODUCTION_BUILD = 'phase-production-build';
const PHASE_PRODUCTION_SERVER = 'phase-production-server';

/**
 * Whether the config is being loaded for something that ships: `next build` or `next start`.
 *
 * `next typegen` (part of `npm run typecheck`) loads the config in the production-build phase as
 * well, with the same NODE_ENV, so the phase alone cannot tell it from `next build`; only the
 * command line can (`argv[2]` is `typegen`). A developer with mocks in `.env.local` must still
 * be able to type-check.
 */
export function isProductionRun(phase: string, argv: readonly string[]): boolean {
  if (phase === PHASE_PRODUCTION_SERVER) return true;
  return phase === PHASE_PRODUCTION_BUILD && argv[2] !== 'typegen';
}

export interface MockGuardInput {
  /** `next build` or `next start`; false for dev, `typegen` and lint, where mocks are the point. */
  isProduction: boolean;
  mocks: readonly string[];
}

export function assertNoMocksInProduction({ isProduction, mocks }: MockGuardInput): void {
  if (isProduction && mocks.length > 0) {
    throw new Error(
      'NEXT_PUBLIC_API_MOCKS must be empty in a production build (mock API is development-only).',
    );
  }
}
