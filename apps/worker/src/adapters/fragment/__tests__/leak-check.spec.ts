import { createLeakCheck } from '../leak-check';
import { tonAddressForms } from '../ton-address-forms';
import {
  BS,
  FAKE,
  FAKE_SECRETS as SECRETS,
  FRAGMENT_PAY_ADDRESS,
  OWNER_WALLET,
  STRANGER_WALLET,
  allSecretForms,
  jsonEscaped,
  loggedInPage,
} from './fragment-fakes';

// The independent leak check (S-1): it decodes on its own and never calls the sanitizer, so
// what the sanitizer misses is still caught. It returns rule names, never values.

const check = createLeakCheck({ secrets: SECRETS, keepAddresses: [FRAGMENT_PAY_ADDRESS] });
const flagged = (text: string): string[] => check(text);

describe('independent leak check', () => {
  it('flags an unsanitized page by rule name only', () => {
    const rules = flagged(loggedInPage());
    expect(rules).toEqual(expect.arrayContaining(['cookie', 'hash', 'name', 'address']));
    for (const rule of rules) {
      expect(allSecretForms()).not.toContain(rule);
      expect(rule).toMatch(/^[a-z_-]+$/);
    }
  });

  it('passes clean text and Fragment’s pay address', () => {
    expect(flagged(`{"ok":true,"to":"${FRAGMENT_PAY_ADDRESS}","amount":"251200000"}`)).toEqual([]);
  });

  it.each([
    ['URL-encoded twice', `?t=%2540${FAKE.username}`, 'username'],
    ['form + for spaces', 'q=Ggwork+%26+Co', 'name'],
    ['decimal entities', [...'Синов'].map((c) => `&#${c.codePointAt(0) ?? 0};`).join(''), 'name'],
    ['JSON escapes', `"${jsonEscaped('Синов')}"`, 'name'],
    ['phone with spaces', '+998 00 000 00 01', 'phone-shape'],
    ['tg id inside a word boundary', `id%3D${FAKE.telegramId}`, 'tg_id'],
    ['last 8 characters of the wallet', `...${OWNER_WALLET.slice(-8)}`, 'address'],
    ['raw wallet hash', `0:${Buffer.alloc(32, 0x07).toString('hex')}`, 'address'],
    ['cookie value', `var s="${FAKE.ssid}"`, 'cookie'],
  ])('decodes %s', (_label, text, rule) => {
    expect(flagged(text)).toContain(rule);
  });

  it('decodes base64 runs, also wrapped across lines and inside a URL', () => {
    const b64 = Buffer.from(`50 Telegram Stars for @${FAKE.username} ${'x'.repeat(60)}`).toString(
      'base64',
    );
    const wrapped = (b64.match(/.{1,40}/g) ?? []).join(`${BS}n`);
    expect(flagged(`{"payload":"${wrapped}"}`)).toContain('username');
    const url = Buffer.from(`for @${FAKE.username} ${'y'.repeat(40)}`).toString('base64url');
    expect(flagged(`ton://transfer/x?bin=${url}`)).toContain('username');
  });

  it('finds the wallet hash at any bit offset inside decoded bytes', () => {
    const hash = Buffer.alloc(32, 0x07);
    for (const shift of [0, 3, 7]) {
      const bits = BigInt(`0x${Buffer.concat([Buffer.from([0x5a, 0xa5]), hash]).toString('hex')}`);
      const shifted = (bits << BigInt(shift)).toString(16);
      const bytes = Buffer.from(shifted.length % 2 === 0 ? shifted : `0${shifted}`, 'hex');
      const run = Buffer.concat([bytes, Buffer.alloc(8, 0x11)]).toString('base64');
      const found = flagged(`"${run}"`).includes('address-bytes');
      expect({ shift, found }).toEqual({ shift, found: true });
    }
  });

  it('flags a TON address that is neither kept nor known', () => {
    expect(flagged(`"${STRANGER_WALLET}"`)).toContain('ton-address');
    const testnet = tonAddressForms({ workchain: 0, hash: Buffer.alloc(32, 0x55) }).find((f) =>
      f.startsWith('0Q'),
    );
    expect(flagged(`"${testnet ?? ''}"`)).toContain('ton-address');
  });

  it('flags generic shapes with no known secret', () => {
    const blind = createLeakCheck({ secrets: [], keepAddresses: [] });
    expect(blind('stel_ssid=abcdef123456')).toContain('cookie-pair');
    expect(blind('/api?hash=0123456789abcdef')).toContain('api-hash');
    expect(blind('//cdn4.telesco.pe/file/x.jpg')).toContain('photo-url');
    expect(blind('a.b@example.com')).toContain('email');
    expect(blind('+7 916 123-45-67')).toContain('phone-shape');
    expect(blind('stel_ssid=<REDACTED:cookie>')).toEqual([]);
  });
});
