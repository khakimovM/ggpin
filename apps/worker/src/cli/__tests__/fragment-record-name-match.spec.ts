import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FAKE, OWNER_WALLET } from '../../adapters/fragment/__tests__/fragment-fakes';
import type { Override } from './fake-fragment';
import { CONFIRM, runRecorder, useTempFolder } from './record-harness';

// Fix round 4 through the whole CLI: a --name only partly shown (M-1), --redact instead of --name
// (M-1), a page without the API hash (L-1) and node command-line options (I-4).

const h = useTempFolder();
const staging = (): string[] => (existsSync(h.stagingDir()) ? readdirSync(h.stagingDir()) : []);
/** The logged-in page shows `html` and nothing else (so it has no API hash either). */
const pageShows =
  (html: string): Override =>
  (call) =>
    call.method === 'GET' && call.cookie !== null
      ? new Response(html, { headers: { 'content-type': 'text/html' } })
      : null;
const withName = (...names: string[]): string[] => [
  '--phone',
  FAKE.phone,
  '--confirm-no-payment',
  '--wallet',
  OWNER_WALLET,
  ...names.flatMap((n) => ['--name', n]),
];

describe('M-1: a --name the answers show only in part', () => {
  it.each([
    ['a typo in the last name', ['Zarina Karimovaa'], '<b>Zarina Karimova</b>', 1, /Karimova/],
    ['H for X', ['Aziz Hakimov', 'Aziz', 'Hakimov'], '<b>Aziz Xakimov</b>', 1, /Hakimov|Xakimov/],
  ])('%s: stages nothing, exits 1, prints no value', async (_id, names, html, n, value) => {
    const { code, stdout, stderr } = await runRecorder(h, withName(...names), {
      override: pageShows(html),
    });
    expect(code).toBe(1);
    expect(stdout).toContain(
      `fragment-record: nothing staged: name ${n} partly found (check --name)`,
    );
    expect(staging()).toEqual([]);
    for (const line of [...stdout, ...stderr]) expect(line).not.toMatch(value);
  });

  it('a --redact line instead of --name is refused before any request', async () => {
    writeFileSync(path.join(h.base(), 'redact.txt'), `${FAKE.displayName}\n`);
    const args = [...withName(), '--redact', 'redact.txt'];
    const { code, stderr, fake } = await runRecorder(h, args);
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(stderr.join('\n')).toContain('--confirm-no-payment needs --name');
  });
});

describe('L-1: no API hash on the page', () => {
  it('stages only the summary and lists every page as withheld', async () => {
    const { code, stdout } = await runRecorder(h, CONFIRM, {
      override: pageShows(`<b>${FAKE.displayName}</b>`),
    });
    expect(code).toBe(1);
    expect(stdout).toContain('fragment-record: withheld: page-logged-in.json (no api hash)');
    expect(staging()).toEqual(['summary.json']);
  });
});

describe('I-4: node command-line options', () => {
  it('refuses --inspect before any request', async () => {
    const { code, fake, stderr } = await runRecorder(h, CONFIRM, { execArgv: ['--inspect'] });
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(stderr).toEqual(['fragment-record: refused, node command-line options are set']);
  });
});
