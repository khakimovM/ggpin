import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FAKE,
  OWNER_WALLET,
  allSecretForms,
  cookieLine,
} from '../../adapters/fragment/__tests__/fragment-fakes';
import { fragmentRecordMain } from '../fragment-record-main';
import { fakeFragment, type FakeFragment, type Override } from './fake-fragment';

// Runs `fragmentRecordMain` against the fake fragment.com in a fresh temp folder (outside every
// git repository): raw responses in <tmp>/raw, staged fixtures in <tmp>/staging.

export interface Harness {
  readonly base: () => string;
  readonly rawDir: () => string;
  readonly stagingDir: () => string;
  readonly staged: (name: string) => string;
}

export function useTempFolder(): Harness {
  let base = '';
  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'fragment-record-'));
    writeFileSync(path.join(base, 'cookies.txt'), `Cookie: ${cookieLine()}\n`);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const rawDir = (): string => path.join(base, 'raw');
  const stagingDir = (): string => path.join(base, 'staging');
  return {
    base: () => base,
    rawDir,
    stagingDir,
    staged: (name) => readFileSync(path.join(stagingDir(), name), 'utf8'),
  };
}

/** The purchase steps with the flags they require (R-2, R-4). */
export const CONFIRM = [
  '--phone',
  FAKE.phone,
  '--confirm-no-payment',
  '--wallet',
  OWNER_WALLET,
  '--name',
  FAKE.displayName,
];

export interface Run {
  readonly code: number;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly sleeps: number[];
  readonly fake: FakeFragment;
}

export interface RunOptions {
  readonly override?: Override;
  readonly env?: Record<string, string>;
  /** Replaces the default --out/--fixtures pair. */
  readonly dirs?: string[];
  /** Replaces the default `--telegram-id <fake id>`. */
  readonly idArgs?: string[];
}

export async function runRecorder(
  h: Harness,
  extra: string[],
  options: RunOptions = {},
): Promise<Run> {
  const fake = fakeFragment(options.override);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sleeps: number[] = [];
  const dirs = options.dirs ?? ['--out', h.rawDir(), '--fixtures', h.stagingDir()];
  const code = await fragmentRecordMain(
    [
      '--cookies',
      'cookies.txt',
      '--username',
      `@${FAKE.username}`,
      ...(options.idArgs ?? ['--telegram-id', FAKE.telegramId]),
      ...dirs,
      ...extra,
    ],
    {
      fetch: fake.fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      now: () => new Date('2030-01-02T03:04:05.000Z'),
      home: h.base(),
      cwd: h.base(),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      env: options.env ?? { NODE_ENV: 'development' },
    },
  );
  return { code, stdout, stderr, sleeps, fake };
}

export function expectClean(text: string, extra: string[] = []): void {
  const lower = text.toLowerCase();
  for (const secret of [...allSecretForms(), ...extra]) {
    expect({ secret, found: lower.includes(secret.toLowerCase()) }).toEqual({
      secret,
      found: false,
    });
  }
}
