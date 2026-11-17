import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : files(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

// Acceptance 5 of phase 9: one stylesheet entry for both apps. The admin imports
// @repo/ui/styles.css and nothing below it, so the token layers cannot be loaded twice or in the
// wrong order.
describe('admin stylesheet entry', () => {
  it('imports the shared entry', () => {
    expect(readFileSync(join(SRC, 'styles.css'), 'utf8')).toContain(
      "@import '@repo/ui/styles.css'",
    );
  });

  it('never imports tokens.css or theme.css directly', () => {
    const offenders = files(SRC).filter((file) =>
      /@repo\/ui\/(tokens|theme)\.css|ui\/(tokens|theme)\.css/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('writes no raw colour in the admin source (tokens only)', () => {
    const raw = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/;
    const offenders = files(SRC).filter((file) => raw.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
