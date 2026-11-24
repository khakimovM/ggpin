import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// docs/04 «So‘rov deadline’i», point 3: the deadline is re-checked before the commit only by
// runActorTransaction. A service that opens its own `$transaction` and calls confirmActorInTx in
// it would skip that check, so every confirmActorInTx call must sit in a runActorTransaction: per
// production file, as many runActorTransaction calls as confirmActorInTx calls (comments are not
// counted). The runtime guard is in confirmActorInTx itself (a tx runActorTransaction did not
// open is a 500); this test only catches a missed pairing before any test runs it.
const SRC = join(__dirname, '..', '..', '..');
const DEFINITION = join('common', 'admin', 'audit-actor.check.ts');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** The code without its comments: a call named in a comment is not a call. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const calls = (text: string, name: string): number =>
  (code(text).match(new RegExp(`\\b${name}(?:<[^(]*>)?\\(`, 'g')) ?? []).length;

describe('confirmActorInTx runs only inside runActorTransaction', () => {
  const files = sources(SRC)
    .filter((path) => relative(SRC, path) !== DEFINITION)
    .map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }))
    .filter((file) => calls(file.text, 'confirmActorInTx') > 0);

  it('finds the admin write services (the 10 of plan 9-B §0.4 and the void)', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    const total = files.reduce((sum, file) => sum + calls(file.text, 'confirmActorInTx'), 0);
    expect(total).toBeGreaterThanOrEqual(12);
  });

  it('every file that calls confirmActorInTx calls runActorTransaction as often', () => {
    const unpaired = files
      .filter(
        (file) => calls(file.text, 'runActorTransaction') < calls(file.text, 'confirmActorInTx'),
      )
      .map((file) => file.path);
    expect(unpaired).toEqual([]);
  });
});
