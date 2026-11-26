import { readdirSync } from 'node:fs';
import path from 'node:path';
import { isAbsoluteRoot, within } from '../fragment-record-paths';
import { runRecorder, useTempFolder } from './record-harness';

// Fix round 5 (audit L-7, I-1, I-3): containment is decided by path segments, so a folder named
// `..x` is inside its parent (a `..` prefix alone does not leave it); Windows comparisons ignore
// letter case and respect folder boundaries; a OneDrive root must be an absolute path. The unit
// tests name the flavour, so the Windows rules are proven on the Linux CI too.

const h = useTempFolder();

describe('within (L-7, I-3)', () => {
  it.each([
    ['C:\\OneDrive', 'C:\\OneDrive', true],
    ['C:\\ONEDRIVE\\x', 'c:\\OneDrive', true],
    ['c:\\onedrive', 'C:\\OneDrive', true],
    ['C:\\OneDrive\\..x', 'C:\\OneDrive', true],
    ['C:\\OneDrive\\...', 'C:\\OneDrive', true],
    ['C:\\OneDrive\\..\\x', 'C:\\OneDrive', false],
    ['C:\\OneDrive2', 'C:\\OneDrive', false],
    ['C:\\OneDrive2\\x', 'C:\\OneDrive', false],
    ['C:\\One', 'C:\\OneDrive', false],
    ['C:\\', 'C:\\OneDrive', false],
    ['D:\\OneDrive', 'C:\\OneDrive', false],
  ])('win32: %s within %s is %s', (child, parent, expected) => {
    expect(within(child, parent, 'win32')).toBe(expected);
  });

  it.each([
    ['/home/a/od', '/home/a/od', true],
    ['/home/a/od/..x', '/home/a/od', true],
    ['/home/a/od/../x', '/home/a/od', false],
    ['/home/a/od2', '/home/a/od', false],
    ['/home/a/OD', '/home/a/od', false],
    ['/home', '/home/a/od', false],
  ])('posix: %s within %s is %s', (child, parent, expected) => {
    expect(within(child, parent, 'posix')).toBe(expected);
  });
});

describe('isAbsoluteRoot (I-1)', () => {
  it.each([
    ['C:\\Users\\a\\OneDrive', true],
    ['c:/Users/a/OneDrive', true],
    ['C:OneDrive', false],
    ['\\OneDrive', false],
    ['/OneDrive', false],
    ['OneDrive', false],
    ['', false],
  ])('win32: %j is %s', (root, expected) => {
    expect(isAbsoluteRoot(root, 'win32')).toBe(expected);
  });

  it.each([
    ['/home/a/OneDrive', true],
    ['OneDrive', false],
    ['C:\\OneDrive', false],
    ['\\OneDrive', false],
  ])('posix: %j is %s', (root, expected) => {
    expect(isAbsoluteRoot(root, 'posix')).toBe(expected);
  });
});

describe('fragment-record: a `..x` folder name stays inside its parent (L-7)', () => {
  it('(a) --out named `..raw` inside --fixtures is refused, nothing written', async () => {
    const out = path.join(h.stagingDir(), '..raw');
    const run = await runRecorder(h, [], { dirs: ['--out', out, '--fixtures', h.stagingDir()] });
    expect(run.code).toBe(2);
    expect(run.fake.calls).toEqual([]);
    expect(run.stderr[0]).toBe(
      'fragment-record: --out and --fixtures must be two separate folders',
    );
    expect(readdirSync(h.base()).sort()).toEqual(['cookies.txt']);
  });

  it('(b) --out under a OneDrive root through a `..x` folder is refused', async () => {
    const root = path.join(h.base(), 'synced');
    const run = await runRecorder(h, [], {
      dirs: ['--out', path.join(root, '..x', 'raw'), '--fixtures', h.stagingDir()],
      env: { NODE_ENV: 'development', OneDrive: root },
    });
    expect(run.code).toBe(2);
    expect(run.fake.calls).toEqual([]);
    expect(run.stderr[0]).toBe('fragment-record: --out is inside OneDrive; use a local folder');
  });
});
