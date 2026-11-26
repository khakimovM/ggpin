import fs from 'node:fs';
import path from 'node:path';
import { runRecorder, useTempFolder, type Run } from './record-harness';

// Fix rounds 4–5 (audit L-5, L-6, I-1, I-2; review): the OneDrive roots read from the environment
// pass the same text checks as the path options before anything resolves them, so a network or
// device root never reaches the file system (no SMB request) and a `:`, relative or odd root never
// gives a wrong comparison. A root with no existing folder above it (a disconnected mapped drive)
// is refused with its variable named. Every refusal names the variable, never its value, and tells
// the owner to fix or unset it; the options keep their own advice.

const h = useTempFolder();
const BS = String.fromCharCode(92);
const realExists = fs.existsSync;
const isNetworkForm = (p: unknown): boolean => typeof p === 'string' && /^[\\/]{2}/.test(p);
const rootRefusal = (name: string, problem: string): string =>
  `fragment-record: environment variable ${name} (a OneDrive root) ${problem}; ` +
  `fix or unset ${name}`;

afterEach(() => jest.restoreAllMocks());

/** `dir` and every folder above it look missing while the checks walk up from `dir`. */
function treeMissing(dir: string): void {
  const resolved = path.resolve(dir);
  const atOrAbove = (p: string): boolean => {
    const rel = path.relative(p, resolved);
    return (
      rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
    );
  };
  let walking = false;
  jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
    const text = String(p);
    if (text === resolved) walking = true;
    if (walking && atOrAbove(text)) return false;
    walking = false;
    return realExists(p);
  });
}

function withRoot(name: string, root: string): Promise<Run> {
  return runRecorder(h, [], { env: { NODE_ENV: 'development', [name]: root } });
}

function expectRefused(run: Run, message: string, hidden: string): void {
  expect(run.code).toBe(2);
  expect(run.fake.calls).toEqual([]);
  expect(run.stderr[0]).toBe(message);
  expect(run.stderr.join('\n')).not.toContain(hidden);
}

describe('fragment-record: OneDrive roots from the environment (L-5)', () => {
  it.each([
    ['OneDrive', `${BS}${BS}h${BS}s`],
    ['OneDriveConsumer', '//h/s'],
    ['OneDriveCommercial', `${BS}${BS}?${BS}C:${BS}od`],
    ['OneDrive', `${BS}${BS}.${BS}C:`],
    ['OneDriveConsumer', `/${BS}h${BS}s`],
  ])('%s=%s is refused by its text, never resolved', async (name, root) => {
    // A network form must not reach the real file system, even on code that would resolve it.
    const exists = jest
      .spyOn(fs, 'existsSync')
      .mockImplementation((p) => (isNetworkForm(p) ? false : realExists(p)));
    const native = jest.spyOn(fs.realpathSync, 'native');
    const run = await withRoot(name, root);
    expectRefused(run, rootRefusal(name, 'is a network or device path'), root);
    for (const [spy, mock] of [
      ['existsSync', exists.mock.calls],
      ['realpathSync.native', native.mock.calls],
    ] as const) {
      const network = mock.filter(([p]) => isNetworkForm(p));
      expect({ spy, network }).toEqual({ spy, network: [] });
    }
  });

  it.each(['::$INDEX_ALLOCATION', ':stream'])(
    'a root with a %s suffix is refused by its text',
    async (suffix) => {
      const run = await withRoot('OneDriveCommercial', path.join(h.base(), `od${suffix}`));
      expectRefused(run, rootRefusal('OneDriveCommercial', "has a ':' in a folder name"), suffix);
    },
  );

  it.each(['od.', 'od '])('a root named %j (dot or space at the end) is refused', async (leaf) => {
    const run = await withRoot('OneDrive', path.join(h.base(), leaf));
    expectRefused(run, rootRefusal('OneDrive', 'has a name ending in a dot or a space'), leaf);
  });

  it.each(['odrel', 'C:odrel', `${BS}odrel`, `odrel${BS}sub`, 'odrel/sub'])(
    'I-1: a relative or drive-relative root %j is refused, not resolved under the cwd',
    async (root) => {
      const run = await withRoot('OneDriveConsumer', root);
      expectRefused(run, rootRefusal('OneDriveConsumer', 'is not an absolute path'), root);
    },
  );

  it('a plain local root still refuses folders inside it and allows the rest', async () => {
    const root = path.join(h.base(), 'synced');
    const inside = await runRecorder(h, [], {
      dirs: ['--out', path.join(root, 'raw'), '--fixtures', h.stagingDir()],
      env: { NODE_ENV: 'development', OneDrive: root },
    });
    expect(inside.code).toBe(2);
    expect(inside.stderr[0]).toContain('--out is inside OneDrive');
    const outside = await withRoot('OneDrive', root);
    // Not refused: the recording reaches the (fake) fragment.com. Code 1 here only means that no
    // --name was given, so nothing is staged (fragment-record-main.ts, R-2).
    expect(outside.stderr).toEqual([]);
    expect(outside.fake.calls.length).toBeGreaterThan(0);
  });
});

describe('fragment-record: no existing folder above a root or an option (L-6, I-2)', () => {
  it('L-6: a root is refused with its variable named, the value never shown', async () => {
    const root = path.join(h.base(), 'gone-drive', 'OneDrive');
    treeMissing(root);
    const run = await withRoot('OneDriveConsumer', root);
    expectRefused(
      run,
      rootRefusal('OneDriveConsumer', 'has no existing folder above it'),
      'gone-drive',
    );
  });

  it('I-2: an option is refused with the option named, the value never shown', async () => {
    const out = path.join(h.base(), 'gone-drive', 'raw');
    treeMissing(out);
    const run = await runRecorder(h, [], { dirs: ['--out', out, '--fixtures', h.stagingDir()] });
    expectRefused(
      run,
      'fragment-record: --out has no existing folder above it; use a local folder',
      'gone-drive',
    );
  });
});
