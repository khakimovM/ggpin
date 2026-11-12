import { createFixtureSanitizer, type SecretValue } from '../fixture-sanitizer';
import { createLeakCheck } from '../leak-check';
import { tonAddressForms } from '../ton-address-forms';
import { BS, FAKE, FRAGMENT_PAY_ADDRESS, form, slashAccountFill } from './fragment-fakes';

// Every case of the S0b security-audit probes (sanitizer.probe.ts + extra.probe.ts) as a test:
// the probe text goes through the same path as a staged fixture (sanitizeJson, then the
// independent leak check). Each case must lose its secret and pass the leak check, so nothing
// from it can reach the staging folder. Z: Fragment's public pay address is kept.

const ch = (...codes: number[]): string => String.fromCharCode(...codes);
const NAME = 'Ozodbek Sinovov';
const OWNER_UQ = form(0x07, 'non-bounceable');
const OWNER_RAW_HEX = Buffer.alloc(32, 0x07).toString('hex');
const SLASH_FORM = form(slashAccountFill(), 'std');
const forms07 = tonAddressForms({ workchain: 0, hash: Buffer.alloc(32, 0x07) });
const TESTNET_0Q = forms07.find((f) => f.startsWith('0Q') && !/[+/]/.test(f)) ?? 'NONE';
const MC_UF =
  tonAddressForms({ workchain: -1, hash: Buffer.alloc(32, 0x07) }).find(
    (f) => f.startsWith('Uf') && !/[+/]/.test(f),
  ) ?? 'NONE';

const boc = (comment: string): Buffer =>
  Buffer.concat([
    Buffer.from([0xb5, 0xee, 0x9c, 0x72, 0x41, 0x01]),
    Buffer.from(`${ch(0, 0, 0, 0)}${comment}`, 'latin1'),
  ]);
const IN_LINK = boc(`50 Telegram Stars for @${FAKE.username}\n\nRef#x1`).toString('base64url');
const SPLIT = boc(`50 Telegram Stars for @owner_te${ch(1, 2)}st_acc\n\nRef#x1`).toString('base64');
const LONG_B64 = boc(
  `50 Telegram Stars for @${FAKE.username} ${'x'.repeat(80)}\n\nRef#x1`,
).toString('base64');
const WRAPPED = (LONG_B64.match(/.{1,76}/g) ?? []).join('\n');

const jsonSlash = (s: string): string => s.split('/').join(`${BS}/`);
const longestPlain = (s: string): string =>
  s.split(/[+/]/).sort((a, b) => b.length - a.length)[0] ?? s;

function secretsFor(full: boolean, name: string): SecretValue[] {
  const secrets: SecretValue[] = [
    { kind: 'cookie', value: FAKE.ssid },
    { kind: 'hash', value: FAKE.hash },
    { kind: 'username', value: FAKE.username },
    { kind: 'name', value: name },
    { kind: 'recipient', value: FAKE.recipient },
  ];
  if (full) {
    secrets.push({ kind: 'tg_id', value: FAKE.telegramId });
    secrets.push({ kind: 'address', value: OWNER_UQ });
    secrets.push({ kind: 'address', value: SLASH_FORM });
  }
  return secrets;
}

interface Case {
  readonly id: string;
  readonly text?: string;
  readonly json?: unknown;
  readonly needle: string;
  readonly full?: boolean;
  readonly name?: string;
}

const tg = FAKE.telegramId;
const user = FAKE.username;
const CASES: Case[] = [
  {
    id: 'A %40user',
    text: `<a href="https://t.me/share/url?text=Stars%20for%20%40${user}">`,
    needle: user,
  },
  { id: 'A2 domain=user', text: `tg://resolve?domain=${user}`, needle: user },
  { id: 'A3 user_bot', text: `@${user}_bot`, needle: user },
  { id: 'B name with +', text: `?text=${NAME.replace(/ /g, '+')}`, needle: 'Sinovov' },
  { id: 'B2 first word only', text: '<span class="tm-x">Ozodbek</span>', needle: 'Ozodbek' },
  {
    id: 'B3 emoji name, PHP JSON escapes',
    text: `ajInit({"title":"Ozodbek ${BS}ud83d${BS}ude80"})`,
    needle: 'Ozodbek',
    name: `Ozodbek ${String.fromCodePoint(0x1f680)}`,
  },
  {
    id: 'B4 apostrophe as &#039;',
    text: '<span>D&#039;Artagnan Test</span>',
    needle: 'Artagnan',
    name: `D${ch(39)}Artagnan Test`,
  },
  {
    id: 'C unknown wallet after /',
    text: `<a href="https://tonviewer.com/${OWNER_UQ}">`,
    needle: OWNER_UQ,
  },
  {
    id: 'C2 known wallet after /',
    text: `<a href="https://tonviewer.com/${OWNER_UQ}">`,
    needle: OWNER_UQ,
    full: true,
  },
  { id: 'D unknown wallet after %3D', text: `?address%3D${OWNER_UQ}`, needle: OWNER_UQ },
  {
    id: 'D2 unknown wallet in attribute',
    text: `<div data-address="${OWNER_UQ}">`,
    needle: OWNER_UQ,
  },
  { id: 'E unknown raw after %22', text: `?a=%220:${OWNER_RAW_HEX}%22`, needle: OWNER_RAW_HEX },
  {
    id: 'E2 known raw after %22',
    text: `?a=%220:${OWNER_RAW_HEX}%22`,
    needle: OWNER_RAW_HEX,
    full: true,
  },
  {
    id: 'F unknown std-b64 with \\/',
    text: `ajInit({"wallet":"${jsonSlash(SLASH_FORM)}"})`,
    needle: longestPlain(SLASH_FORM),
  },
  {
    id: 'F2 known std-b64 with \\/',
    text: `ajInit({"w":"${jsonSlash(SLASH_FORM)}"})`,
    needle: longestPlain(SLASH_FORM),
    full: true,
  },
  {
    id: 'F3 known std-b64 with %2F',
    text: `?a=${encodeURIComponent(SLASH_FORM)}`,
    needle: longestPlain(SLASH_FORM),
    full: true,
  },
  { id: 'G id not given, data attribute', text: `<div data-user-id="${tg}">`, needle: tg },
  { id: 'G2 id not given, page JSON', text: `ajInit({"user":{"id":${tg}}})`, needle: tg },
  { id: 'H id given after %3D', text: `?q=user_id%3D${tg}`, needle: tg, full: true },
  {
    id: 'I BOC in ton link bin=',
    text: `ton://transfer/${FRAGMENT_PAY_ADDRESS}?amount=1&bin=${IN_LINK}`,
    needle: IN_LINK.slice(0, 30),
  },
  { id: 'J BOC with split username', json: { payload: SPLIT }, needle: SPLIT.slice(0, 30) },
  { id: 'K BOC wrapped at 76', json: { payload: WRAPPED }, needle: LONG_B64.slice(0, 40) },
  {
    id: 'O other token key',
    text: 'ajInit({"token":"zz9Other0Session8Token7Value"})',
    needle: 'zz9Other0Session8Token7Value',
  },
  { id: 'Q phone +7 with spaces', text: '<span>+7 916 123-45-67</span>', needle: '916 123-45-67' },
  { id: 'P placeholder-shaped text', text: `<REDACTED:${user}>`, needle: user },
  { id: 'T1 username mixed case', text: 'https://t.me/Owner_Test_Acc', needle: user },
  { id: 'T2 testnet 0Q form', text: `"${TESTNET_0Q}"`, needle: TESTNET_0Q },
  { id: 'T3 masterchain Uf form', text: `"${MC_UF}"`, needle: MC_UF },
  { id: 'T4 name with &nbsp;', text: '<b>Ozodbek&nbsp;Sinovov</b>', needle: 'Sinovov' },
  { id: 'T4b name with &#160;', text: '<b>Ozodbek&#160;Sinovov</b>', needle: 'Sinovov' },
  { id: 'T7 user after %2F', text: `?url=https%3A%2F%2Ft.me%2F${user}`, needle: user },
  {
    id: 'T8 protocol-relative photo',
    text: '<img src="//cdn4.telesco.pe/file/fakeUserpicFile0000.jpg">',
    needle: 'fakeUserpicFile0000',
  },
  {
    id: 'T10 e-mail',
    text: '<span>owner.mail@example.com</span>',
    needle: 'owner.mail@example.com',
  },
  {
    id: 'T11 cookie value in a script',
    text: `<script>var s="${FAKE.ssid}";</script>`,
    needle: FAKE.ssid,
  },
  {
    id: 'T12 hash in upper case',
    text: `{"apiUrl":"/api?hash=${FAKE.hash.toUpperCase()}"}`,
    needle: FAKE.hash,
  },
];

function staged(c: Case): { text: string; leaks: string[] } {
  const secrets = secretsFor(c.full === true, c.name ?? NAME);
  const keepAddresses = [FRAGMENT_PAY_ADDRESS];
  const sanitizer = createFixtureSanitizer({ secrets, keepAddresses });
  const value = c.json ?? { response: { bodyKind: 'html-excerpt', body: c.text ?? '' } };
  const text = `${JSON.stringify(sanitizer.sanitizeJson(value), null, 2)}\n`;
  return { text, leaks: createLeakCheck({ secrets, keepAddresses })(text) };
}

describe('security-audit probe cases (S0b fix round)', () => {
  it('builds every probe value (no NONE placeholder)', () => {
    for (const v of [TESTNET_0Q, MC_UF, SLASH_FORM]) expect(v).not.toBe('NONE');
    expect(SLASH_FORM).toContain('/');
  });

  it.each(CASES.map((c) => [c.id, c] as const))(
    '%s: the secret does not reach staging',
    (_id, c) => {
      const { text, leaks } = staged(c);
      expect({ survives: text.toLowerCase().includes(c.needle.toLowerCase()) }).toEqual({
        survives: false,
      });
      expect(leaks).toEqual([]);
    },
  );

  it('Z: keeps Fragment’s pay address in a ton link', () => {
    const { text, leaks } = staged({
      id: 'Z',
      text: `ton://transfer/${FRAGMENT_PAY_ADDRESS}?amount=1`,
      needle: FRAGMENT_PAY_ADDRESS,
    });
    expect(text).toContain(FRAGMENT_PAY_ADDRESS);
    expect(leaks).toEqual([]);
  });

  it('the leak check alone flags the known-secret probes before sanitizing', () => {
    const secrets = secretsFor(true, NAME);
    const check = createLeakCheck({ secrets, keepAddresses: [FRAGMENT_PAY_ADDRESS] });
    for (const c of CASES.filter(
      (x) => x.full === true || x.id.startsWith('A') || x.id.startsWith('T7'),
    )) {
      const raw = JSON.stringify({ body: c.text ?? '' });
      expect({ id: c.id, flagged: check(raw).length > 0 }).toEqual({ id: c.id, flagged: true });
    }
  });
});
