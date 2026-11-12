import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OWNER_WALLET } from '../../adapters/fragment/__tests__/fragment-fakes';
import { CONFIRM, runRecorder, useTempFolder } from './record-harness';

// Fix round 2 (R-3, R-5, R-10, audit P1–P7): where the recorder may read and write. Every check
// runs on the real path, so a junction cannot lead a folder into a git repository. Junctions need
// no admin rights on Windows (and become directory symlinks elsewhere).

const h = useTempFolder();
const BS = String.fromCharCode(92);

function fakeRepo(): string {
  const repo = path.join(h.base(), 'fakerepo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  mkdirSync(path.join(repo, 'sub'), { recursive: true });
  return repo;
}

async function refused(dirs: string[], message: string, extra: string[] = []): Promise<void> {
  const { code, fake, stderr } = await runRecorder(h, extra, { dirs });
  expect(code).toBe(2);
  expect(fake.calls).toEqual([]);
  expect(stderr[0]).toContain(message);
}

describe('fragment-record: real paths (R-5, audit P1–P7)', () => {
  it('P1: --out through a junction into a repository is refused', async () => {
    const repo = fakeRepo();
    symlinkSync(path.join(repo, 'sub'), path.join(h.base(), 'jlink'), 'junction');
    const raw = path.join(h.base(), 'jlink', 'raw');
    await refused(['--out', raw, '--fixtures', h.stagingDir()], '--out is inside a git repository');
    expect(existsSync(path.join(repo, 'sub', 'raw'))).toBe(false);
  });

  it('P1b: --fixtures through a junction into a repository is refused', async () => {
    const repo = fakeRepo();
    symlinkSync(path.join(repo, 'sub'), path.join(h.base(), 'jlink'), 'junction');
    const staging = path.join(h.base(), 'jlink', 'stage');
    await refused(['--out', h.rawDir(), '--fixtures', staging], '--fixtures is inside a git');
    expect(existsSync(path.join(repo, 'sub', 'stage'))).toBe(false);
  });

  it('P2: --out as a junction to --fixtures is refused (one real folder)', async () => {
    mkdirSync(h.stagingDir());
    symlinkSync(h.stagingDir(), path.join(h.base(), 'same'), 'junction');
    await refused(
      ['--out', path.join(h.base(), 'same'), '--fixtures', h.stagingDir()],
      'two separate folders',
    );
    expect(readdirSync(h.stagingDir())).toEqual([]);
  });

  it('P3, P4: `..` and another letter case into the repository are refused', async () => {
    fakeRepo();
    const viaDots = path.join(h.base(), 'x', '..', 'fakerepo', 'st');
    await refused(['--out', h.rawDir(), '--fixtures', viaDots], 'inside a git repository');
    if (process.platform === 'win32') {
      const upper = path.join(h.base(), 'FAKEREPO', 'st');
      await refused(['--out', h.rawDir(), '--fixtures', upper], 'inside a git repository');
    }
  });

  it('P5, P6: device and UNC paths are refused', async () => {
    const device = `${BS}${BS}?${BS}${path.join(h.base(), 'st')}`;
    await refused(['--out', h.rawDir(), '--fixtures', device], 'network or device path');
    const unc = `${BS}${BS}localhost${BS}c$${BS}st`;
    await refused(['--out', unc, '--fixtures', h.stagingDir()], 'network or device path');
  });

  it('P7: a name ending in a dot or a space is refused', async () => {
    fakeRepo();
    const dotted = path.join(h.base(), 'fakerepo.', 'st');
    await refused(['--out', h.rawDir(), '--fixtures', dotted], 'ending in a dot or a space');
    const spaced = path.join(h.base(), 'raw ', 'x');
    await refused(['--out', spaced, '--fixtures', h.stagingDir()], 'ending in a dot or a space');
  });
});

describe('fragment-record: OneDrive, ggpin-secrets and input files (R-3, R-10)', () => {
  it('refuses a OneDrive segment and a OneDrive root from the environment', async () => {
    const segment = path.join(h.base(), 'OneDrive - Org', 'st');
    await refused(['--out', h.rawDir(), '--fixtures', segment], 'inside OneDrive');
    const root = path.join(h.base(), 'synced');
    const { code, stderr } = await runRecorder(h, [], {
      dirs: ['--out', path.join(root, 'raw'), '--fixtures', h.stagingDir()],
      env: { NODE_ENV: 'development', OneDrive: root },
    });
    expect(code).toBe(2);
    expect(stderr[0]).toContain('--out is inside OneDrive');
  });

  it('R-3: refuses a staging folder inside ggpin-secrets', async () => {
    const staging = path.join(h.base(), 'ggpin-secrets', 'staging');
    await refused(['--out', h.rawDir(), '--fixtures', staging], 'inside ggpin-secrets');
    expect(existsSync(staging)).toBe(false);
  });

  it.each(['--redact', '--ton-connect'])('R-10: refuses a %s file inside a repo', async (flag) => {
    const repo = fakeRepo();
    const file = path.join(repo, 'input.txt');
    writeFileSync(
      file,
      flag === '--redact' ? 'Ggwork Co\n' : JSON.stringify({ address: OWNER_WALLET }),
    );
    const { code, fake, stderr } = await runRecorder(h, [...CONFIRM, flag, file]);
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(stderr[0]).toContain(`${flag} is inside a git repository`);
  });

  it('R-10: refuses a --cookies file inside a repo, before any folder is made', async () => {
    mkdirSync(path.join(h.base(), '.git'));
    const { code, fake, stderr } = await runRecorder(h, [], {
      dirs: ['--out', path.join(h.base(), '..', 'unused-raw'), '--fixtures', h.stagingDir()],
    });
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(stderr[0]).toContain('--cookies is inside a git repository');
    expect(existsSync(h.stagingDir())).toBe(false);
  });
});
