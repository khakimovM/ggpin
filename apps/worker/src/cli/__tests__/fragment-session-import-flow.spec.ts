import type { FragmentJar } from '../../adapters/fragment/fragment-cookie-jar';
import { CookieInputError } from '../../adapters/fragment/fragment-cookie-jar';
import { importFragmentSession } from '../fragment-session-import-flow';

// `fragment:session-import` (Q9, phase 5 S7): the pasted cookies become the ACTIVE session; what
// it prints is a count, cookie NAMES and the new row id: never a value. Made-up low-entropy values.

function importer() {
  const jars: FragmentJar[] = [];
  return {
    jars,
    store: {
      importSession: (jar: FragmentJar) => {
        jars.push(jar);
        return Promise.resolve('cmsession0000000000000001');
      },
    },
  };
}

describe('importFragmentSession', () => {
  it('stores the jar (no page hash yet) and prints names and the id only', async () => {
    const { jars, store } = importer();
    const said: string[] = [];
    const input = 'stel_ssid=sess-one\nstel_token=token-one\nstel_dt=-300\n';
    await expect(importFragmentSession(input, store, (l) => said.push(l))).resolves.toBe(
      'cmsession0000000000000001',
    );
    expect(jars).toEqual([
      {
        cookies: new Map([
          ['stel_ssid', 'sess-one'],
          ['stel_token', 'token-one'],
          ['stel_dt', '-300'],
        ]),
        pageHash: null,
      },
    ]);
    const printed = said.join('\n');
    expect(printed).toContain('imported 3 cookies (stel_dt, stel_ssid, stel_token)');
    expect(printed).toContain('cmsession0000000000000001');
    for (const value of ['sess-one', 'token-one', '-300']) expect(printed).not.toContain(value);
  });

  it('warns about an expected cookie that is missing, and still imports', async () => {
    const { jars, store } = importer();
    const said: string[] = [];
    await importFragmentSession('Cookie: stel_ssid=sess-one', store, (l) => said.push(l));
    expect(said[0]).toBe('warning: no stel_token cookie (expected, not required)');
    expect(jars).toHaveLength(1);
  });

  it('bad input stores nothing and the error names no value', async () => {
    const { jars, store } = importer();
    const said: string[] = [];
    const work = importFragmentSession('stel_ssid=sess-one\nnot a cookie', store, (l) =>
      said.push(l),
    );
    await expect(work).rejects.toThrow(CookieInputError);
    await expect(work).rejects.not.toThrow(/sess-one|not a cookie/);
    expect(jars).toEqual([]);
    expect(said).toEqual([]);
  });
});
