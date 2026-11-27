import fs, { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  OutputRefusal,
  assertLocalForm,
  assertNotInSecrets,
  realPathOf,
} from '../fragment-record-paths';
import { fsSpies } from './fs-spies';
import { CONFIRM, runRecorder, useTempFolder } from './record-harness';

// Fix round 3 (audit L-1, L-2, L-4; review on NTFS streams): network and device forms are refused
// by their text alone, on every OS, before any file-system call; a path with no existing folder
// above it is refused; a `:` stream suffix cannot rename a folder past the name checks.

const h = useTempFolder();
const BS = String.fromCharCode(92);
const NETWORK = ['//h/s', '/' + BS + 'h/s'];

afterEach(() => jest.restoreAllMocks());

describe('assertLocalForm', () => {
  it.each([
    `${BS}${BS}h${BS}s`,
    '//h/s',
    `${BS}/h`,
    `/${BS}h`,
    `${BS}${BS}?${BS}C:${BS}x`,
    `${BS}${BS}.${BS}C:`,
  ])('refuses %s', (value) => {
    expect(() => assertLocalForm(value, '--out')).toThrow(OutputRefusal);
    expect(() => assertLocalForm(value, '--out')).toThrow('--out is a network or device path');
  });

  it.each(['/tmp/x', `C:${BS}x`, 'rel/x'])('accepts %s', (value) => {
    expect(() => assertLocalForm(value, '--out')).not.toThrow();
  });
});

describe('fragment-record: network forms in every path option (L-4)', () => {
  const cases = ['--cookies', '--out', '--fixtures', '--ton-connect', '--redact'].flatMap((flag) =>
    NETWORK.map((value) => [flag, value] as const),
  );

  it('control: each spy sees calls of a run that is not refused', async () => {
    // Empty folders that already exist, so the emptiness check reads them (readdir fires too).
    mkdirSync(h.rawDir());
    mkdirSync(h.stagingDir());
    const spies = fsSpies();
    await runRecorder(h, []);
    spies.expectEach();
  });

  it.each(cases)('%s %s is refused before any file-system call', async (flag, value) => {
    const dirs = ['--out', h.rawDir(), '--fixtures', h.stagingDir()];
    if (flag === '--out') dirs[1] = value;
    if (flag === '--fixtures') dirs[3] = value;
    const extra = flag === '--ton-connect' || flag === '--redact' ? [...CONFIRM, flag, value] : [];
    const spies = fsSpies();
    const run = await runRecorder(h, extra, {
      dirs,
      ...(flag === '--cookies' ? { cookies: value } : {}),
    });
    expect(run.code).toBe(2);
    expect(run.fake.calls).toEqual([]);
    expect(run.stderr[0]).toContain(`${flag} is a network or device path`);
    spies.expectNone();
  });

  it.each([`${BS}${BS}h${BS}s`, '//h/s'])(
    'L-1: the default folders under a network home (%s) are refused, no file-system call',
    async (home) => {
      const spies = fsSpies();
      const run = await runRecorder(h, [], { dirs: [], home });
      expect(run.code).toBe(2);
      expect(run.fake.calls).toEqual([]);
      expect(run.stderr[0]).toContain('--out is a network or device path');
      spies.expectNone();
    },
  );

  it.each([`${BS}${BS}h${BS}s`, '//h/s'])(
    'L-1: a relative --cookies under a network cwd (%s) is refused, no file-system call',
    async (cwd) => {
      const spies = fsSpies();
      const run = await runRecorder(h, [], { cwd });
      expect(run.code).toBe(2);
      expect(run.fake.calls).toEqual([]);
      expect(run.stderr[0]).toContain('--cookies is a network or device path');
      spies.expectNone();
    },
  );
});

describe('fragment-record: no existing folder above, NTFS streams (L-2, review)', () => {
  it('L-2: a path with no existing folder above it is refused, the value never shown', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const p = path.join(h.base(), 'gone', 'x');
    expect(() => realPathOf(p)).toThrow(OutputRefusal);
    let message = '';
    try {
      realPathOf(p);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('a path has no existing folder above it; use a local folder');
  });

  it.each(['::$INDEX_ALLOCATION', ':stream'])(
    'a ggpin-secrets%s staging folder is refused before any folder is made',
    async (suffix) => {
      const staging = path.join(h.base(), `ggpin-secrets${suffix}`, 'staging');
      const run = await runRecorder(h, [], {
        dirs: ['--out', h.rawDir(), '--fixtures', staging],
      });
      expect(run.code).toBe(2);
      expect(run.fake.calls).toEqual([]);
      expect(run.stderr[0]).toContain("--fixtures has a ':' in a folder name");
      expect(existsSync(path.join(h.base(), 'ggpin-secrets'))).toBe(false);
      expect(existsSync(h.rawDir())).toBe(false);
    },
  );

  it.each(['::$INDEX_ALLOCATION', ':stream'])(
    'assertNotInSecrets alone sees ggpin-secrets%s as ggpin-secrets',
    (suffix) => {
      const staging = path.join(h.base(), `GGPIN-Secrets${suffix}`, 'staging');
      expect(() => assertNotInSecrets(staging, '--fixtures')).toThrow(
        '--fixtures is inside ggpin-secrets',
      );
    },
  );

  it('a stream suffix on a repository folder is refused by its text', async () => {
    const out = path.join(h.base(), 'fakerepo::$INDEX_ALLOCATION', 'raw');
    const run = await runRecorder(h, [], { dirs: ['--out', out, '--fixtures', h.stagingDir()] });
    expect(run.code).toBe(2);
    expect(run.stderr[0]).toContain("--out has a ':' in a folder name");
  });
});
