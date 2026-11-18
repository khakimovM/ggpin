import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { FAKE } from '../../adapters/fragment/__tests__/fragment-fakes';
import {
  HOLDER,
  holderErrorResponse,
  holderSecretForms,
} from '../../adapters/fragment/__tests__/premium-fakes';
import { parseFragmentRecordArgs } from '../fragment-record-args';
import type { FakeCall, Override } from './fake-fragment';
import { CONFIRM, expectClean, runRecorder, useTempFolder } from './record-harness';

// P6-S0a: --premium-holder, an account that already has Premium (Q10). It is a third person: its
// username and name must never reach staging or the console in any form, and without the flag
// nobody but the owner is searched.

const h = useTempFolder();
const HOLDER_ARGS = ['--premium-holder', HOLDER.username, '--premium-holder-name', HOLDER.name];
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const isHolderSearch = (call: FakeCall): boolean =>
  call.form?.get('method') === 'searchPremiumGiftRecipient' &&
  call.form.get('query') === HOLDER.username;
const holderAnswer =
  (body: unknown): Override =>
  (call) =>
    isHolderSearch(call) ? json(body) : null;
const summaryOf = (): Record<string, unknown> =>
  JSON.parse(h.staged('summary.json')) as Record<string, unknown>;

function expectNoHolderAnywhere(lines: readonly string[]): void {
  const files = existsSync(h.stagingDir()) ? readdirSync(h.stagingDir()) : [];
  for (const file of files) expectClean(h.staged(file), [FAKE.telegramId, ...holderSecretForms()]);
  for (const line of lines) expectClean(line, [h.base(), ...holderSecretForms()]);
}

describe('P6-S0a: --premium-holder', () => {
  it('without the flag, nobody but the owner is searched', async () => {
    const { code, fake } = await runRecorder(h, CONFIRM);
    expect(code).toBe(0);
    const queries = fake.calls.flatMap((c) => c.form?.get('query') ?? []);
    expect(queries).toEqual([FAKE.username, FAKE.username]);
    expect(readdirSync(h.stagingDir())).not.toContain('search-premium-holder.json');
  });

  it('searches the holder once (3 months) and stages the answer with every holder value redacted', async () => {
    const { code, fake, stdout, stderr } = await runRecorder(h, [...CONFIRM, ...HOLDER_ARGS]);
    expect(code).toBe(0);
    const holderCalls = fake.calls.filter(isHolderSearch);
    expect(holderCalls).toHaveLength(1);
    expect(holderCalls[0]?.form?.get('months')).toBe('3');
    const text = h.staged('search-premium-holder.json');
    expect(text).toContain('"query": "<REDACTED:username>"');
    expect(text).toContain('<REDACTED:name>');
    expect(text).toContain('already has Telegram Premium');
    expectNoHolderAnywhere([...stdout, ...stderr]);
    expect(summaryOf()).toMatchObject({
      names: { ownerCovered: true, holderSearched: true, holderCovered: true },
    });
  });

  it('redacts the holder name and username given only as free text (no `found`)', async () => {
    const { code, stdout } = await runRecorder(h, [...CONFIRM, ...HOLDER_ARGS], {
      override: holderAnswer(holderErrorResponse()),
    });
    expect(code).toBe(0);
    const body = (
      JSON.parse(h.staged('search-premium-holder.json')) as {
        response: { body: Record<string, unknown> };
      }
    ).response.body;
    expect(body).toEqual({
      ok: false,
      error: '<REDACTED:name> (@<REDACTED:username>) already has Telegram Premium',
      premium: true,
    });
    expectNoHolderAnywhere(stdout);
  });

  it('a holder name the answer does not show: its text is withheld under strict text (exit 1)', async () => {
    const { code, stdout } = await runRecorder(h, [...CONFIRM, ...HOLDER_ARGS], {
      override: holderAnswer(holderErrorResponse('Someone Else')),
    });
    expect(code).toBe(1);
    expect(stdout).toContain(
      'fragment-record: withheld: search-premium-holder.json values (1 not plain text; strict)',
    );
    const staged = JSON.parse(h.staged('search-premium-holder.json')) as {
      response: { strictText: boolean; body: unknown };
    };
    expect(staged.response.strictText).toBe(true);
    expect(staged.response.body).toEqual({ ok: false, error: '<REDACTED:secret>', premium: true });
    expect(h.staged('search-premium-holder.json')).not.toContain('Someone');
    expect(summaryOf()).toMatchObject({
      names: { ownerCovered: true, holderSearched: true, holderCovered: false },
    });
    expectNoHolderAnywhere(stdout);
  });

  it('a holder name only partly shown (likely mistyped): nothing staged, exit 1', async () => {
    const { code, stdout } = await runRecorder(h, [...CONFIRM, ...HOLDER_ARGS], {
      override: holderAnswer(holderErrorResponse('Dilnoza Qosimovaa')),
    });
    expect(code).toBe(1);
    expect(stdout).toContain(
      'fragment-record: nothing staged: premium holder name 1 partly found (check --premium-holder-name)',
    );
    expect(readdirSync(h.stagingDir())).toEqual([]);
    expectNoHolderAnywhere(stdout);
  });

  it('R-2: a holder name never stands in for the owner name', async () => {
    const nameless = (call: FakeCall): Response | null => {
      const m = call.form?.get('method');
      if (call.method === 'GET' && call.cookie !== null) {
        return new Response(
          `<html><body><script>ajInit({"apiUrl":"\\/api?hash=${FAKE.hash}"});</script></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      }
      if (isHolderSearch(call)) return null;
      return m === 'searchStarsRecipient' || m === 'searchPremiumGiftRecipient'
        ? json({ ok: true, found: { recipient: FAKE.recipient } })
        : null;
    };
    const { code, stdout } = await runRecorder(h, HOLDER_ARGS, { override: nameless });
    expect(code).toBe(1);
    expect(stdout).toContain(
      'fragment-record: nothing staged: no display name is known (give --name)',
    );
    expect(readdirSync(h.stagingDir())).toEqual([]);
  });
});

describe('P6-S0a: --premium-holder arguments', () => {
  const CTX = { home: path.resolve('/home/x'), cwd: path.resolve('/home/x'), now: new Date(0) };
  const base = ['--cookies', 'c.txt', '--username', 'owner_one', '--telegram-id', '700100200'];
  const parse = (extra: string[]) => () => parseFragmentRecordArgs([...base, ...extra], CTX);

  it('reads the holder and its names (the name repeats)', () => {
    const args = parse([...HOLDER_ARGS, '--premium-holder-name', 'Dilnoza'])();
    expect(args.premiumHolder).toBe(HOLDER.username);
    expect(args.premiumHolderNames).toEqual([HOLDER.name, 'Dilnoza']);
  });

  it('refuses a holder without a name, a name without a holder, and the owner as holder', () => {
    expect(parse(['--premium-holder', HOLDER.username])).toThrow(
      '--premium-holder needs --premium-holder-name',
    );
    expect(parse(['--premium-holder-name', HOLDER.name])).toThrow(
      '--premium-holder-name needs --premium-holder',
    );
    expect(parse(['--premium-holder', '@Owner_One', '--premium-holder-name', 'Abc'])).toThrow(
      'another account',
    );
    expect(parse(['--premium-holder', 'no', '--premium-holder-name', 'Abc'])).toThrow(
      '--premium-holder must be a Telegram username',
    );
    expect(parse(['--premium-holder', HOLDER.username, '--premium-holder-name', 'Ab'])).toThrow(
      '--premium-holder-name is too short',
    );
  });

  it('error messages never echo the holder values', () => {
    let message = '';
    try {
      parse(['--premium-holder', HOLDER.username])();
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('--premium-holder needs --premium-holder-name');
    expectClean(message, holderSecretForms());
  });
});
