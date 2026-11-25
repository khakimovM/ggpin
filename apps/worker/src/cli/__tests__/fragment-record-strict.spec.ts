import { existsSync, readdirSync } from 'node:fs';
import { FAKE } from '../../adapters/fragment/__tests__/fragment-fakes';
import { HOLDER, holderSecretForms } from '../../adapters/fragment/__tests__/premium-fakes';
import type { FakeCall, Override } from './fake-fragment';
import { CONFIRM, expectClean, runRecorder, useTempFolder } from './record-harness';

// P6-S0a fix round (CR F1/F3/F6, SA F1/F2/F3/F7): a holder name given only in part, a free-text
// answer, a patronymic, a nickname, another script, a name as a key, an id number: none of them
// may reach staging. Regression tests of the reviewers' probes (CR P1, P1b, P3; SA A1-A4, B).

const h = useTempFolder();
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const isHolder = (c: FakeCall): boolean =>
  c.form?.get('method') === 'searchPremiumGiftRecipient' && c.form.get('query') === HOLDER.username;
const holderAnswer =
  (body: unknown): Override =>
  (c) =>
    isHolder(c) ? json(body) : null;
const holderArgs = (...names: string[]): string[] => [
  ...CONFIRM,
  '--premium-holder',
  HOLDER.username,
  ...names.flatMap((n) => ['--premium-holder-name', n]),
];
const stagedFiles = (): string[] =>
  existsSync(h.stagingDir()) ? readdirSync(h.stagingDir()).map((f) => h.staged(f)) : [];
const holderBody = (): unknown =>
  (JSON.parse(h.staged('search-premium-holder.json')) as { response: { body: unknown } }).response
    .body;
const STRICT_LINE =
  'fragment-record: withheld: search-premium-holder.json values (1 not plain text; strict)';

describe('fix round A: holder name coverage (fail closed)', () => {
  it('CR P1 / SA A1: only the first name given, the surname in free text: never staged', async () => {
    const { code, stdout } = await runRecorder(h, holderArgs('Dilnoza'), {
      override: holderAnswer({
        ok: false,
        error: `${HOLDER.name} (@${HOLDER.username}) already has Telegram Premium`,
      }),
    });
    expect(code).toBe(1);
    expect(stdout).toContain(STRICT_LINE);
    expect(holderBody()).toEqual({ ok: false, error: '<REDACTED:secret>' });
    for (const text of stagedFiles()) expectClean(text, holderSecretForms());
  });

  it('CR P1b: the name in an html string under an unknown key: never staged', async () => {
    await runRecorder(h, holderArgs('Dilnoza'), {
      override: holderAnswer({ ok: true, html: `<div class="tm-x">${HOLDER.name}</div>` }),
    });
    expect(holderBody()).toEqual({ ok: true, html: '<REDACTED:secret>' });
    for (const text of stagedFiles()) expectClean(text, holderSecretForms());
  });

  it('SA A2: only the first name given, found.name full: the surname is nowhere', async () => {
    const { stdout } = await runRecorder(h, holderArgs('Dilnoza'));
    for (const text of stagedFiles()) expectClean(text, holderSecretForms());
    for (const line of stdout) expectClean(line, holderSecretForms());
    const summary = JSON.parse(h.staged('summary.json')) as { names: unknown };
    expect(summary.names).toEqual({
      ownerCovered: true,
      holderSearched: true,
      holderCovered: false,
    });
  });

  it.each([
    ['a patronymic', `${HOLDER.name} Rustamovna`, 'Rustamovna'],
    ['a nickname', `Dilnoza "Dili" Qosimova`, 'Dili'],
    ['another script', `Дилноза Қосимова (${HOLDER.name})`, 'Дилноза'],
  ])('the full name given, %s in free text: withheld', async (_what, shown, leak) => {
    const { code, stdout } = await runRecorder(h, holderArgs(HOLDER.name), {
      override: holderAnswer({ ok: false, error: `${shown} already has Telegram Premium` }),
    });
    expect(code).toBe(1);
    expect(stdout).toContain(STRICT_LINE);
    for (const text of stagedFiles()) expectClean(text, [leak, ...holderSecretForms()]);
  });

  it('SA F7: a generic error with no name is kept as it is (exit 0)', async () => {
    const { code } = await runRecorder(h, holderArgs(HOLDER.name), {
      override: holderAnswer({ ok: false, error: 'This account already has Telegram Premium' }),
    });
    expect(code).toBe(0);
    expect(holderBody()).toEqual({
      ok: false,
      error: 'This account already has Telegram Premium',
    });
  });
});

describe('fix round B, D: keys and id numbers in the holder answer', () => {
  it.each([
    ['latin', 'Dilya Kasymova'],
    ['cyrillic', 'Дилноза Қосимова'],
  ])('CR P3 / SA A3: a %s name as a key becomes a key placeholder', async (_what, key) => {
    await runRecorder(h, holderArgs(HOLDER.name), {
      override: holderAnswer({ ok: false, users: { [key]: 'has premium' } }),
    });
    expect(holderBody()).toEqual({ ok: false, users: { '<REDACTED:key#1>': 'has premium' } });
    for (const text of stagedFiles()) expectClean(text, [key, ...key.split(' ')]);
  });

  it('SA A4: every 5+ digit number in the holder answer is 0', async () => {
    await runRecorder(h, holderArgs(HOLDER.name), {
      override: holderAnswer({
        ok: true,
        found: { recipient: HOLDER.recipient, name: HOLDER.name, myself: false },
        user: { id: 7123456789, peer_id: 7123456789 },
        score: 7123456789,
        months: 3,
      }),
    });
    const text = h.staged('search-premium-holder.json');
    expectClean(text, ['7123456789', '123456789']);
    expect(holderBody()).toMatchObject({ user: { id: 0, peer_id: 0 }, score: 0, months: 3 });
  });
});

describe('SA B: holder forms (the full name given)', () => {
  const b64 = (s: string): string => Buffer.from(s).toString('base64');
  const forms = ['Dilnoza', 'Qosimova', 'gift_holder_acc', 'giftholderacc', 'Dil​noza'];
  it.each([
    ['entity', '&#68;&#105;lnoza Qosimova (&#64;gift&#95;holder&#95;acc) already has Premium'],
    ['urlenc', 'Dilnoza%20Qosimova%20%40gift_holder_acc already has Premium'],
    ['jsonesc', 'Dilnoza Qosimova (@gift_holder_acc)'],
    ['b64', `Dilnoza Qosimova; ref ${b64('to Dilnoza Qosimova @gift_holder_acc please')}`],
    [
      'html',
      '<div class="tm-gift-name">Dilnoza Qosimova</div><a href="https://t.me/gift_holder_acc">x</a>',
    ],
    ['upper', 'Dilnoza Qosimova (@GIFT_HOLDER_ACC)'],
    ['zwsp', 'Dil​noza Qosimova'],
  ])('%s: no holder form is staged', async (_what, text) => {
    await runRecorder(h, holderArgs(HOLDER.name), {
      override: holderAnswer({ ok: false, error: text }),
    });
    for (const staged of stagedFiles()) {
      const lower = staged.toLowerCase();
      for (const f of forms) expect(lower).not.toContain(f.toLowerCase());
    }
  });
});

describe('fix round A: the owner --name follows the same rule', () => {
  const FIRST = 'Ozodbek';
  const SURNAME = 'Синов';
  const ownerArgs = CONFIRM.map((a) => (a === FAKE.displayName ? FIRST : a));
  const ownerSearch = (c: FakeCall): boolean =>
    c.form?.get('method') === 'searchStarsRecipient' ||
    (c.form?.get('method') === 'searchPremiumGiftRecipient' &&
      c.form.get('query') === FAKE.username);
  const ownerAnswer =
    (body: unknown): Override =>
    (c) =>
      ownerSearch(c) ? json(body) : null;

  it('the first name only, the full name in free text (no found.name): never staged', async () => {
    const { code, stdout } = await runRecorder(h, ownerArgs, {
      override: ownerAnswer({
        ok: true,
        found: { recipient: FAKE.recipient },
        note: `${FIRST} ${SURNAME} can gift Premium`,
      }),
    });
    expect(code).toBe(1);
    expect(stdout.some((l) => l.includes('owner name not covered by --name; strict'))).toBe(true);
    for (const text of stagedFiles()) expectClean(text, [SURNAME, FAKE.displayName]);
    const summary = JSON.parse(h.staged('summary.json')) as { names: { ownerCovered: boolean } };
    expect(summary.names.ownerCovered).toBe(false);
  });

  it('the first name only, found.name longer: the owner files are strict', async () => {
    const { code } = await runRecorder(h, ownerArgs);
    expect(code).toBe(1);
    for (const text of stagedFiles()) expectClean(text, [SURNAME, FAKE.displayName]);
    const page = JSON.parse(h.staged('page-logged-in.json')) as {
      response: { strictText: boolean; body: unknown };
    };
    expect(page.response).toMatchObject({ strictText: true, body: '<REDACTED:secret>' });
  });

  it('another script and a nickname next to the given name: withheld', async () => {
    await runRecorder(h, CONFIRM, {
      override: ownerAnswer({
        ok: true,
        found: { recipient: FAKE.recipient },
        note: `Озодбек "Ozzy" ${FAKE.displayName}`,
      }),
    });
    for (const text of stagedFiles()) expectClean(text, ['Озодбек', 'Ozzy']);
  });

  it('a generic text with no name stays when the owner name is covered (exit 0)', async () => {
    const { code } = await runRecorder(h, CONFIRM);
    expect(code).toBe(0);
    const page = JSON.parse(h.staged('page-logged-in.json')) as { response: { body: unknown } };
    expect(typeof page.response.body).toBe('object');
  });
});

describe('fix round 2: what slipped past rule (b) (CR N1-N3, SA R1/R2/R4/R7)', () => {
  const APOS = String.fromCharCode(39);
  it.each([
    [
      'M3 split digits',
      HOLDER.name,
      { error: 'user 712-345-6789 has Premium', peer: '712 345 6789' },
      ['712-345-6789', '712 345 6789'],
    ],
    [
      'M4 apostrophe name',
      'Karimova',
      { error: `Ro${APOS}za Karimova already has Premium` },
      [`ro${APOS}za`],
    ],
    ['M4b U+2018 name', 'Karimova', { error: 'Ro‘za Karimova already has Premium' }, ['ro‘za']],
    ['M5 2-letter surname', 'Anna', { error: 'Anna Li already has Premium' }, [' li ']],
    [
      'M8/N6 made-up placeholder',
      'Dilnoza',
      { error: 'Dilnoza <REDACTED:Qosimova> has Premium' },
      ['qosimova'],
    ],
    [
      'N1 entities',
      'Dilnoza',
      { error: 'Dilnoza &#81;&#111;&#115;&#105;&#109;&#111;&#118;&#97; has Premium' },
      ['&#81;'],
    ],
    ['N2 percent', 'Dilnoza', { link: 'https://t.me/share?text=%D0%94%D0%B8%D0%BB' }, ['%D0%94']],
    ['N3 CJK', 'Dilnoza', { error: 'Dilnoza 王伟 already has Telegram Premium' }, ['王伟']],
    ['N4 NFD', 'Dilnoza', { error: 'Dilnoza Lèa already has Telegram Premium' }, ['lèa', 'lèa']],
    ['N5 zero-width', 'Dilnoza', { error: 'Dilnoza Q​o​s​i​m​o​v​a has Premium' }, ['q​o']],
  ])('%s: withheld', async (_what, name, body, needles) => {
    const { code } = await runRecorder(h, holderArgs(name), {
      override: holderAnswer({ ok: false, ...body }),
    });
    expect(code).toBe(1);
    const text = h.staged('search-premium-holder.json').toLowerCase();
    for (const n of needles) expect(text).not.toContain(n.toLowerCase());
  });

  it('SA R7: the owner search free text is strict even when --name covers found.name', async () => {
    const premiumSearch = (c: FakeCall): boolean =>
      c.form?.get('method') === 'searchPremiumGiftRecipient' &&
      c.form.get('query') === FAKE.username;
    const { code, stdout } = await runRecorder(h, CONFIRM, {
      override: (c) =>
        premiumSearch(c)
          ? json({ ok: false, error: `${FAKE.displayName} Rustamovich already has Premium` })
          : null,
    });
    expect(code).toBe(1);
    expect(stdout).toContain(
      'fragment-record: withheld: search-premium-recipient.json values (1 not plain text; strict)',
    );
    for (const text of stagedFiles()) expectClean(text, ['Rustamovich']);
    const summary = JSON.parse(h.staged('summary.json')) as { names: { ownerCovered: boolean } };
    expect(summary.names.ownerCovered).toBe(true);
  });

  it('rule (a): a found.name with no word (emoji only) is not covered', async () => {
    const { code } = await runRecorder(h, CONFIRM, {
      override: (c) =>
        c.form?.get('method') === 'searchStarsRecipient'
          ? json({ ok: true, found: { recipient: FAKE.recipient, name: '\u{1F600}\u{1F680}' } })
          : null,
    });
    expect(code).toBe(1);
    const summary = JSON.parse(h.staged('summary.json')) as { names: { ownerCovered: boolean } };
    expect(summary.names.ownerCovered).toBe(false);
  });
});
