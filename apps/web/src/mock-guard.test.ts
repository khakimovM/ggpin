import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from 'next/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../next.config';
import { assertNoMocksInProduction, isProductionRun } from './mock-guard';

describe('assertNoMocksInProduction', () => {
  it('stops a production build that has mock groups', () => {
    expect(() => assertNoMocksInProduction({ isProduction: true, mocks: ['orders'] })).toThrow(
      /NEXT_PUBLIC_API_MOCKS/,
    );
  });

  it('lets a production build without mocks through', () => {
    expect(() => assertNoMocksInProduction({ isProduction: true, mocks: [] })).not.toThrow();
  });

  it('lets development use mocks', () => {
    expect(() =>
      assertNoMocksInProduction({ isProduction: false, mocks: ['quotes', 'orders'] }),
    ).not.toThrow();
  });
});

// `argv` as Node reports it: [node, <path to next>, <command>, ...].
const NEXT = ['node', '/project/node_modules/next/dist/bin/next'];

describe('isProductionRun', () => {
  it('next build and next start are production', () => {
    expect(isProductionRun(PHASE_PRODUCTION_BUILD, [...NEXT, 'build'])).toBe(true);
    expect(isProductionRun(PHASE_PRODUCTION_SERVER, [...NEXT, 'start'])).toBe(true);
  });

  it('next typegen loads the production-build phase but is not a production run', () => {
    expect(isProductionRun(PHASE_PRODUCTION_BUILD, [...NEXT, 'typegen'])).toBe(false);
  });

  it('a build worker with no command in argv is treated as production (the safe side)', () => {
    expect(isProductionRun(PHASE_PRODUCTION_BUILD, ['node', '/worker.js'])).toBe(true);
  });

  it('the dev server is not production', () => {
    expect(isProductionRun(PHASE_DEVELOPMENT_SERVER, [...NEXT, 'dev'])).toBe(false);
  });
});

// The same wiring through the real next.config.ts, with mocks switched on.
describe('next.config.ts with mocks enabled', () => {
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
  });

  function loadConfig(phase: string, command: string) {
    vi.stubEnv('NEXT_PUBLIC_API_MOCKS', 'orders');
    process.argv = [...NEXT, command];
    return () => config(phase);
  }

  it('refuses next build', () => {
    expect(loadConfig(PHASE_PRODUCTION_BUILD, 'build')).toThrow(/NEXT_PUBLIC_API_MOCKS/);
  });

  it('refuses next start', () => {
    expect(loadConfig(PHASE_PRODUCTION_SERVER, 'start')).toThrow(/NEXT_PUBLIC_API_MOCKS/);
  });

  it('lets next typegen through', () => {
    expect(loadConfig(PHASE_PRODUCTION_BUILD, 'typegen')).not.toThrow();
  });

  it('lets next dev through', () => {
    expect(loadConfig(PHASE_DEVELOPMENT_SERVER, 'dev')).not.toThrow();
  });
});
