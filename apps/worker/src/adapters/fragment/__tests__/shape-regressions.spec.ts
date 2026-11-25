import { randomBytes } from 'node:crypto';
import { createFixtureSanitizer } from '../fixture-sanitizer';
import { createLeakCheck } from '../leak-check';
import { PAY, secrets } from './bypass-cases';
import { recoverable } from './recovery-oracle';

// Round 4 (L-1, I-2, I-3): the cookie and hash shapes of the R3 audit with values the recorder does
// NOT know, JS escapes of a known cookie, and base64 images of an unknown user. Each must be
// withheld or clean; the harmless page constructs of the audit must still be staged (F-7).

const BS = String.fromCharCode(92);
const KNOWN_SSID = ['fake', 'ssid', '0000aaaa1111bbbb'].join('');
const UNKNOWN = `fake${'unknown'}cookie77`;
const UNKNOWN_HASH = `${'9f8e'.repeat(4)}aa`;
const sec = secrets('full');
const sanitizer = createFixtureSanitizer({ secrets: sec, keepAddresses: [PAY] });
const leak = createLeakCheck({ secrets: sec, keepAddresses: [PAY] });

/** The writeFixture path: whole text sanitized, staged JSON walked again, both leak-checked. */
function verdict(input: { text?: string; json?: unknown }, needle: string): string {
  const full = input.text === undefined ? '' : sanitizer.sanitizeText(input.text);
  const value = input.json ?? { response: { bodyKind: 'html-excerpt', body: full } };
  const staged = `${JSON.stringify(sanitizer.sanitizeJson(value), null, 2)}\n`;
  const flags = [...leak(staged), ...(full === '' ? [] : leak(full))];
  if (flags.length > 0) return 'withheld';
  return recoverable(staged, needle) ? 'LEAK' : 'clean';
}

const COOKIE: Array<[string, (v: string) => string]> = [
  ['C02 stel_ssid:v', (v) => `stel_ssid:${v}`],
  ['C03 stel_ssid: v', (v) => `stel_ssid: ${v}`],
  ['C12 stel_ssid&equals;v', (v) => `stel_ssid&equals;${v}`],
  ["C16 {'stel_ssid':'v'}", (v) => `<script>x={'stel_ssid':'${v}'}</script>`],
  ["C17 {stel_ssid:'v'}", (v) => `<script>x={stel_ssid:'${v}'}</script>`],
  ['C18 {stel_ssid:"v"}', (v) => `<script>x={stel_ssid:"${v}"}</script>`],
  ['C19 stel_ssid="v"', (v) => `stel_ssid="${v}"`],
  ["C20 stel_ssid='v'", (v) => `stel_ssid='${v}'`],
  ['C27 ["stel_ssid","v"]', (v) => `<script>c=["stel_ssid","${v}"]</script>`],
  ['C28 name=stel_ssid&value=v', (v) => `name=stel_ssid&value=${v}`],
  ['C30 stel_ssid=&quot;v&quot;', (v) => `stel_ssid=&quot;${v}&quot;`],
  ['C15 escaped JSON in a string', (v) => `x="{${BS}"stel_ssid${BS}":${BS}"${v}${BS}"}"`],
];
const COOKIE_JSON: Array<[string, (v: string) => unknown]> = [
  ['CJ2 [{name:"stel_ssid",value:v}]', (v) => ({ list: [{ name: 'stel_ssid', value: v }] })],
  ['CJ3 {msg:"stel_ssid: v"}', (v) => ({ msg: `stel_ssid: ${v}` })],
];
const HASH: Array<[string, (h: string) => string]> = [
  ['H08 \\"hash\\":\\"h\\"', (h) => `<script>x="{${BS}"hash${BS}":${BS}"${h}${BS}"}"</script>`],
  ["H09 'hash':'h'", (h) => `<script>x={'hash':'${h}'}</script>`],
  ["H10 hash:'h'", (h) => `<script>x={hash:'${h}'}</script>`],
  ['H11 hash:"h"', (h) => `<script>x={hash:"${h}"}</script>`],
  ['H12 hash: h', (h) => `hash: ${h}`],
  ['H13 api_hash=h', (h) => `<a href="/x?api_hash=${h}">`],
  ['H14 apiHash=h', (h) => `apiHash=${h}`],
  ['H15 apihash=h', (h) => `apihash=${h}`],
  ['H18 apiHash:"h"', (h) => `<script>x={apiHash:"${h}"}</script>`],
  ["H19 api_hash:'h'", (h) => `<script>x={api_hash:'${h}'}</script>`],
  ['H25 data-hash="h"', (h) => `<div data-hash="${h}"></div>`],
  ['H26 /api/hash/h', (h) => `/api/hash/${h}`],
  ['H30 ?api_hash=h&x=1', (h) => `{"apiUrl":"${BS}/api?api_hash=${h}&x=1"}`],
];

describe('L-1: cookie and hash shapes with an unknown value', () => {
  it.each(COOKIE)('%s', (_id, make) => {
    expect(['withheld', 'clean']).toContain(verdict({ text: `<p>${make(UNKNOWN)}</p>` }, UNKNOWN));
  });
  it.each(COOKIE_JSON)('%s', (_id, make) => {
    expect(['withheld', 'clean']).toContain(verdict({ json: make(UNKNOWN) }, UNKNOWN));
  });
  it.each(HASH)('%s', (_id, make) => {
    const text = `<p>${make(UNKNOWN_HASH)}</p>`;
    expect(['withheld', 'clean']).toContain(verdict({ text }, UNKNOWN_HASH));
  });
  it('HJ2 {apiUrl:"/api?api_hash=h"}', () => {
    const json = { apiUrl: `/api?api_hash=${UNKNOWN_HASH}` };
    expect(['withheld', 'clean']).toContain(verdict({ json }, UNKNOWN_HASH));
  });
  it('the sanitizer itself removes the common forms (not only the leak check)', () => {
    expect(sanitizer.sanitizeText(`stel_ssid: ${UNKNOWN}`)).toBe('stel_ssid: <REDACTED:cookie>');
    expect(sanitizer.sanitizeText(`apiHash="${UNKNOWN_HASH}"`)).toBe('apiHash="<REDACTED:hash>"');
    // A "name" key is always redacted as a name; the value next to a cookie name is the cookie.
    expect(sanitizer.sanitizeJson({ id: 'stel_ssid', value: UNKNOWN })).toEqual({
      id: 'stel_ssid',
      value: '<REDACTED:cookie>',
    });
  });
});

describe('I-2: JS escapes of a known cookie', () => {
  const hex = (s: string): string =>
    [...s].map((c) => `${BS}x${(c.codePointAt(0) ?? 0).toString(16).padStart(2, '0')}`).join('');
  const braces = (s: string): string =>
    [...s].map((c) => `${BS}u{${(c.codePointAt(0) ?? 0).toString(16)}}`).join('');
  it.each([
    ['\\xNN', hex],
    ['\\u{N}', braces],
  ])('%s', (_id, encode) => {
    const text = `<script>x="${encode(KNOWN_SSID)}"</script>`;
    expect(['withheld', 'clean']).toContain(verdict({ text }, KNOWN_SSID));
  });
  it('E20: the first 11 characters of a known cookie are withheld', () => {
    const cut = KNOWN_SSID.slice(0, 11);
    expect(verdict({ text: `<p>${cut}</p>` }, cut)).toBe('withheld');
  });
});

describe('I-3: base64 images of an unknown user', () => {
  const b64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(600)]).toString(
    'base64',
  );
  const wrapped = (b64.match(/.{1,76}/g) ?? []).join('\n');
  it.each([
    ['P02 charset', `data:image/jpeg;charset=utf-8;base64,${b64}`],
    ['P03 name', `data:image/jpeg;name=me.jpg;base64,${b64}`],
    ['P04 octet-stream', `data:application/octet-stream;base64,${b64}`],
    ['P06 wrapped at 76', `data:image/jpeg;base64,${wrapped}`],
  ])('%s: no 16-char run of the image is staged', (_id, uri) => {
    const staged = JSON.stringify(sanitizer.sanitizeJson({ body: `<img src="${uri}">` }));
    const flat = staged.replace(/\\n|\s/g, '');
    for (let i = 0; i + 16 <= b64.length; i += 16) expect(flat).not.toContain(b64.slice(i, i + 16));
  });
});

describe('F-7 still holds: harmless constructs are staged', () => {
  it.each([
    "<script>document.cookie='stel_dt='+encodeURIComponent(-(new Date).getTimezoneOffset()*60)+';path=/';</script>",
    "<script>if(document.cookie.indexOf('stel_ssid=')<0){}</script>",
    "<script>document.cookie='stel_ssid=; expires=Thu, 01 Jan 1970 00:00:00 GMT';</script>",
    '<script>var stelKeys={stel_ssid:1,stel_dt:1};</script>',
    '<a href="/x?infohash=abcdef1234567">x</a>',
    '<div style="background:url(&quot;data:image/svg+xml,%3Csvg%2F%3E&quot;)"></div>',
    '{"cookieNamesSupplied": ["stel_dt", "stel_ssid", "stel_token"]}',
  ])('%s', (text) => {
    expect(
      leak(JSON.stringify(sanitizer.sanitizeJson({ body: sanitizer.sanitizeText(text) }))),
    ).toEqual([]);
  });
});
