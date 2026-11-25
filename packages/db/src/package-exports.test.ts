import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Audit N4: `applyTransition` (the unrestricted order status writer) is not exported from the index,
// but a deep import (`@repo/db/dist/orders/order-transition-core`) used to reach it and move
// NEEDS_REVIEW -> DELIVERED with no proof. The package `exports` map now lets the package be imported
// by its name only. Nothing in the repository imports a subpath (checked when this was added).

const manifest: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const exportsMap = (manifest as { exports?: Record<string, unknown> }).exports;

describe('@repo/db package exports', () => {
  it('expose the package root and nothing else', () => {
    expect(exportsMap).toBeDefined();
    expect(Object.keys(exportsMap ?? {})).toEqual(['.']);
    expect(exportsMap?.['.']).toEqual({
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
  });

  it('has no subpath, pattern or condition that would reach dist, src or the generated client', () => {
    const text = JSON.stringify(exportsMap);
    for (const forbidden of ['dist/orders', 'src/', 'generated', '*', 'package.json']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    // Node resolves `@repo/db/<anything>` through this map only: a key that is not "." is the only
    // way to open a subpath, and there is none (the runtime proof is in the S1 report).
    expect(Object.keys(exportsMap ?? {}).filter((key) => key !== '.')).toEqual([]);
  });
});
