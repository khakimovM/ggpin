import type { SecretValue } from '../fixture-sanitizer';
import { tonAddressForms } from '../ton-address-forms';

// The security re-audit bypass cases of fix round 2 (scratchpad s0b-reaudit/bypass.probe.ts),
// kept as regression data: each one must end up withheld or clean, never a leak. All values are
// made up. KEEP1 (the owner wallet handed in as a kept address) is left out on purpose: the
// recorder keeps only the single pay address of a one-message link (R-4), see the CLI tests.
const BS = String.fromCharCode(92);
const Q = String.fromCharCode(39);
const username = 'owner_test_acc';
const name = 'Ozodbek Sinovov';
const tgId = '700100200';
const ssid = ['fake', 'ssid', '0000aaaa1111bbbb'].join('');
const hash = 'ab12cd34ef567890aa';
const recipient = 'fakeRecipientOpaque0123456789';
const formsOf = (h: Buffer): string[] => tonAddressForms({ workchain: 0, hash: h });
const pick = (forms: string[], prefix: string, urlSafe: boolean): string =>
  forms.find((f) => f.startsWith(prefix) && (urlSafe ? !/[+/]/.test(f) : /[+/]/.test(f))) ?? 'NONE';
export const ownerHash = Buffer.from(Array.from({ length: 32 }, (_v, i) => (i * 37 + 11) % 256));
export const OWNER = pick(formsOf(ownerHash), 'UQ', true);
export const OWNER_EQ = pick(formsOf(ownerHash), 'EQ', true);
export const PAY = pick(formsOf(Buffer.alloc(32, 0x2a)), 'EQ', true);
let slashForm = 'NONE';
for (let f = 1; f < 256 && slashForm === 'NONE'; f += 1) {
  if (f === 0x2a) continue;
  slashForm =
    formsOf(Buffer.alloc(32, f)).find((x) => x.startsWith('UQ') && x.includes('/')) ?? 'NONE';
}
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const pct = (s: string): string =>
  [...Buffer.from(s, 'utf8')]
    .map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');
const ent = (s: string): string => [...s].map((c) => `&#${c.codePointAt(0) ?? 0};`).join('');
const jesc = (s: string): string =>
  [...s].map((c) => `${BS}u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`).join('');
const CYR = '\u0419\u045e\u043b\u0434\u043e\u0448 \u0401\u049b\u0443\u0431\u043e\u0432';
const CYR_WORD = '\u0419\u045e\u043b\u0434\u043e\u0448';

export type Variant = 'full' | 'noName' | 'noWallet' | 'cyr';
export function secrets(v: Variant, extra: SecretValue[] = []): SecretValue[] {
  const s: SecretValue[] = [
    { kind: 'cookie', value: ssid },
    { kind: 'hash', value: hash },
    { kind: 'username', value: username },
    { kind: 'recipient', value: recipient },
    { kind: 'tg_id', value: tgId },
  ];
  if (v !== 'noName') s.push({ kind: 'name', value: v === 'cyr' ? CYR : name });
  if (v !== 'noWallet') s.push({ kind: 'address', value: OWNER });
  return [...s, ...extra];
}
export interface BypassCase {
  id: string;
  text?: string;
  json?: unknown;
  needle: string;
  v?: Variant;
  keep?: string[];
  extra?: SecretValue[];
}
const ELL = String.fromCharCode(0x2026);
export const BYPASS_CASES: BypassCase[] = [
  {
    id: 'MIX1 entity inside URL (%26%23111%3B)',
    text: '?t=%26%23111%3Bwner_test_acc',
    needle: username,
  },
  { id: 'MIX2 URL inside entity (&#37;6F)', text: 'x &#37;6Fwner_test_acc', needle: username },
  {
    id: 'MIX3 base64 URL-encoded',
    text: '?d=' + encodeURIComponent(b64('for @' + username + ' and some more text ~~~~>>>>????')),
    needle: username,
  },
  {
    id: 'MIX4 URL-encoded inside base64 (json)',
    json: { payload: b64(pct(username)) },
    needle: username,
  },
  {
    id: 'MIX4b URL-encoded inside base64 (html)',
    text: '<a data-x="' + b64('u=' + pct(username)) + '">',
    needle: username,
  },
  {
    id: 'MIX5 entities inside base64',
    json: { v: b64(ent('owner') + '_test_acc') },
    needle: username,
  },
  {
    id: 'MIX6 JSON escapes inside base64',
    json: { v: b64(jesc('owner_test_acc')) },
    needle: username,
  },
  {
    id: 'MIX7 base64 inside base64',
    json: { v: b64(b64('50 Telegram Stars for @' + username)) },
    needle: username,
  },
  {
    id: 'MIX8 short base64 of username (<24 chars)',
    text: 'https://t.me/x?start=' + b64(username).replace(/=+$/, ''),
    needle: username,
  },
  { id: 'MIX9 short base64 of tg id', text: '?ref=' + b64(tgId), needle: tgId },
  {
    id: 'NFD1 page NFD, secret NFC (cyrillic name)',
    text: '<b>' + CYR.normalize('NFD') + '</b>',
    needle: CYR_WORD,
    v: 'cyr',
  },
  {
    id: 'NFD2 page NFC, --redact NFD',
    text: '<b>' + CYR + '</b>',
    needle: CYR_WORD,
    v: 'noName',
    extra: [{ kind: 'secret', value: CYR.normalize('NFD') }],
  },
  {
    id: 'FW1 tg id fullwidth digits',
    text: '<i>' + [...tgId].map((d) => String.fromCharCode(0xff10 + Number(d))).join('') + '</i>',
    needle: tgId,
  },
  { id: 'SEP1 tg id 700,100,200', text: 'id 700,100,200', needle: tgId },
  { id: 'SEP2 tg id 700_100_200', text: 'id 700_100_200', needle: tgId },
  { id: 'SEP3 tg id with apostrophes', text: 'id 700' + Q + '100' + Q + '200', needle: tgId },
  { id: 'SEP4 tg id with U+200B', text: 'id 700\u200b100\u200b200', needle: tgId },
  { id: 'SEP5 tg id with &#8203;', text: 'id 700&#8203;100200', needle: tgId },
  { id: 'SEP6 tg id with soft hyphen', text: 'id 700\u00ad100200', needle: tgId },
  { id: 'SEP7 tg id 700/100/200', text: 'id 700/100/200', needle: tgId },
  { id: 'SEP8 tg id 700 100 200 (space)', text: 'id 700 100 200', needle: tgId },
  { id: 'SEP9 tg id 700.100.200', text: 'id 700.100.200', needle: tgId },
  {
    id: 'PART1 known wallet first4...last4 (ellipsis)',
    text: '<div class="tm-wallet">' + OWNER.slice(0, 4) + ELL + OWNER.slice(-4) + '</div>',
    needle: OWNER.slice(-4),
  },
  {
    id: 'PART2 known wallet first6...last6',
    text: '<div class="tm-wallet">' + OWNER.slice(0, 6) + '...' + OWNER.slice(-6) + '</div>',
    needle: OWNER.slice(-6),
  },
  {
    id: 'PART3 known wallet first 24 chars',
    text: 'w=' + OWNER.slice(0, 24),
    needle: OWNER.slice(0, 24),
  },
  {
    id: 'PART4 known wallet first 31 chars',
    text: 'w=' + OWNER.slice(0, 31),
    needle: OWNER.slice(0, 31),
  },
  {
    id: 'PART5 known wallet last 7 chars',
    text: 'w=' + ELL + OWNER.slice(-7),
    needle: OWNER.slice(-7),
  },
  {
    id: 'PART6 unknown wallet first 31 chars',
    text: 'w=' + OWNER.slice(0, 31),
    needle: OWNER.slice(0, 31),
    v: 'noWallet',
  },
  {
    id: 'PART7 unknown wallet first4...last4',
    text: OWNER.slice(0, 4) + ELL + OWNER.slice(-4),
    needle: OWNER.slice(-4),
    v: 'noWallet',
  },
  {
    id: 'CASE1 username upper, URL-encoded',
    text: '?q=' + pct(username.toUpperCase()),
    needle: username,
  },
  { id: 'CASE2 username upper, entities', text: ent('OW') + 'NER_TEST_ACC', needle: username },
  { id: 'SPLIT1 username with <wbr>', text: '@owner_<wbr>test_acc', needle: username },
  { id: 'SPLIT2 username with &shy;', text: '@owner_&shy;test_acc', needle: username },
  { id: 'SPLIT3 username with U+200B', text: '@owner_\u200btest_acc', needle: username },
  { id: 'SPLIT4 username across spans', text: '@owner_<span>test_acc</span>', needle: username },
  { id: 'NAME-SPLIT name across tags', text: 'Ozod<b></b>bek Sino<i>vov</i>', needle: 'Ozodbek' },
  {
    id: 'NEST1 JSON-in-JSON-in-JSON, known name',
    json: { data: JSON.stringify({ inner: JSON.stringify({ first_name: 'Ozodbek' }) }) },
    needle: 'Ozodbek',
  },
  {
    id: 'NEST2 JSON-in-JSON-in-JSON, unknown name',
    json: { data: JSON.stringify({ inner: JSON.stringify({ first_name: 'Zarina' }) }) },
    needle: 'Zarina',
    v: 'noName',
  },
  {
    id: 'KEY1 unknown name under found.title',
    json: { ok: true, found: { recipient, title: 'Zarina Karimova' } },
    needle: 'Zarina',
    v: 'noName',
  },
  {
    id: 'KEY2 unknown name under peer_name (json walk)',
    json: { peer_name: 'Zarina Karimova' },
    needle: 'Zarina',
    v: 'noName',
  },
  {
    id: 'KEY3 unknown name under peer_name (embedded in page)',
    text: 'ajInit({"peer_name":"Zarina Karimova"})',
    needle: 'Zarina',
    v: 'noName',
  },
  {
    id: 'KEY4 unknown name in header div',
    text: '<div class="tm-header-action-name">Zarina Karimova</div>',
    needle: 'Zarina',
    v: 'noName',
  },
  {
    id: 'ASPLIT1 unknown wallet split by newline',
    text: OWNER.slice(0, 24) + '\n' + OWNER.slice(24),
    needle: OWNER.slice(0, 24),
    v: 'noWallet',
  },
  {
    id: 'ASPLIT2 known wallet split by newline',
    text: OWNER.slice(0, 24) + '\n' + OWNER.slice(24),
    needle: OWNER.slice(0, 24),
  },
  {
    id: 'ASPLIT3 unknown wallet split by <wbr>',
    text: OWNER.slice(0, 20) + '<wbr>' + OWNER.slice(20),
    needle: OWNER.slice(0, 20),
    v: 'noWallet',
  },
  {
    id: 'HEX1 unknown owner hash bare hex (account_id)',
    json: { account_id: ownerHash.toString('hex') },
    needle: ownerHash.toString('hex'),
    v: 'noWallet',
  },
  { id: 'PHONE1 local UZ 90 123 45 67', text: '<span>90 123 45 67</span>', needle: '901234567' },
  {
    id: 'PHONE2 RU domestic 8 (916) 123-45-67',
    text: '<span>8 (916) 123-45-67</span>',
    needle: '9161234567',
  },
  {
    id: 'PHONE3 998 90 123 45 67 (no +)',
    text: '<span>998 90 123 45 67</span>',
    needle: '998901234567',
  },
  {
    id: 'MAIL1 e-mail with &#64;',
    text: 'owner.mail&#64;example.com',
    needle: 'owner.mail@example.com',
  },
  {
    id: 'MAIL2 e-mail with %40',
    text: 'owner.mail%40example.com',
    needle: 'owner.mail@example.com',
  },
  {
    id: 'F-fixed unknown std-b64 wallet JSON-escaped (fill != pay)',
    text: 'ajInit({"wallet":"' + slashForm.split('/').join(BS + '/') + '"})',
    needle: slashForm.split(/[+/]/).sort((a, b) => b.length - a.length)[0] ?? slashForm,
    v: 'noWallet',
  },
  {
    id: 'KEEP2 owner wallet in keep list, wallet known (json value)',
    json: { messages: [{ address: PAY }, { address: OWNER_EQ }] },
    needle: OWNER_EQ,
    keep: [PAY, OWNER_EQ],
  },
  {
    id: 'KEEP3 owner wallet in keep list, unknown, other form in page',
    text: '<div class="tm-wallet">' + OWNER + '</div>',
    needle: OWNER,
    v: 'noWallet',
    keep: [PAY, OWNER_EQ],
  },
];
