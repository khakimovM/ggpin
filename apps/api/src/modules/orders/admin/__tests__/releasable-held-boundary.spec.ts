import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Phase 5 S9i (S9e SA N-4, review R5): RELEASABLE_HELD_REASONS is the worker reconciler's list of
// the HELD reasons it may release BY ITSELF once their cause is gone (D-64 (4)), not a list of what
// an operator may release. The API never derives its own rules from it, so a later change of the
// reconciler's list cannot widen an admin path unseen. This spec scans the API's own sources (its
// turbo hash covers them); the worker holds its side in order-reconcile-static-db.spec.ts.

const API_SRC = join(__dirname, '../../../..');
const NAMES = /\b(RELEASABLE_HELD_REASONS|ReleasableHeldReason)\b/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return name.endsWith('.ts') && !/\.(spec|e2e-spec)\.ts$/.test(name) ? [path] : [];
  });
}

describe('the API and the reconciler’s releasable HELD reasons (S9i N-4)', () => {
  it('scans the API sources (control: this tree has its main.ts)', () => {
    expect(sources(API_SRC).map((f) => relative(API_SRC, f))).toContain('main.ts');
  });

  it('no API source names RELEASABLE_HELD_REASONS or ReleasableHeldReason', () => {
    const users = sources(API_SRC).filter((file) => NAMES.test(readFileSync(file, 'utf8')));
    expect(users.map((file) => relative(API_SRC, file).split(sep).join('/'))).toEqual([]);
  });
});
