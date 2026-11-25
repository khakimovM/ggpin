import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { FragmentSessionKey } from '../../../config/fragment-session-env';
import { AesGcmError, sealAesGcm } from '../../../crypto/aes-gcm';
import {
  CookieInputError,
  MAX_COOKIES,
  applySetCookies,
  cookieHeader,
  parseCookieInput,
  type FragmentJar,
} from '../fragment-cookie-jar';
import {
  FRAGMENT_SESSION_AAD,
  FragmentJarFormatError,
  FragmentSessionKeyMissingError,
  FragmentSessionStore,
  openJar,
  sealJar,
} from '../fragment-session.store';

// The encrypted cookie jar of a Fragment session (phase 5 S7). Every key is made at run time and
// every cookie value is a low-entropy made-up word: nothing here looks like a secret.

const newKey = (): Buffer => randomBytes(32);
const JAR: FragmentJar = {
  cookies: new Map([
    ['stel_ssid', 'sess-one'],
    ['stel_token', 'token-one'],
  ]),
  pageHash: 'abc123abc123',
};

describe('the sealed jar', () => {
  it('round trip: cookies and page hash come back; the blob shows neither', () => {
    const key = newKey();
    const blob = sealJar(JAR, key);
    expect(blob).not.toContain('sess-one');
    expect(blob).not.toContain('abc123abc123');
    expect(Buffer.from(blob, 'base64').toString('latin1')).not.toContain('sess-one');
    expect(openJar(blob, key)).toEqual(JAR);
    expect(sealJar(JAR, key)).not.toBe(blob); // a fresh IV every time
  });

  it('a wrong key, another purpose (AAD) or a damaged blob is refused, naming no value', () => {
    const key = newKey();
    const blob = sealJar(JAR, key);
    expect(() => openJar(blob, newKey())).toThrow(AesGcmError);
    const plain = Buffer.from(JSON.stringify({ v: 1, cookies: {}, pageHash: null }));
    const otherPurpose = sealAesGcm(plain, key, 'ggpin/wallet-mnemonic/v1');
    expect(() => openJar(otherPurpose, key)).toThrow(AesGcmError);
    const bytes = Buffer.from(blob, 'base64');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(() => openJar(bytes.toString('base64'), key)).toThrow(AesGcmError);
    try {
      openJar(blob, newKey());
    } catch (error) {
      expect(String(error)).not.toContain('sess-one');
    }
  });

  it('a blob of our purpose that is not a jar is FragmentJarFormatError', () => {
    const key = newKey();
    for (const json of ['not json', '{"v":2,"cookies":{},"pageHash":null}', '{"v":1}']) {
      const blob = sealAesGcm(Buffer.from(json), key, FRAGMENT_SESSION_AAD);
      expect(() => openJar(blob, key)).toThrow(FragmentJarFormatError);
    }
  });

  it('the store needs the key: without it nothing opens or saves (NO_KEY)', async () => {
    const prisma = { client: {} } as never;
    const store = new FragmentSessionStore(prisma);
    expect(() => store.open('x')).toThrow(FragmentSessionKeyMissingError);
    await expect(store.save({ id: 's1', status: 'ACTIVE', cookiesEnc: 'x' }, JAR)).rejects.toThrow(
      FragmentSessionKeyMissingError,
    );
  });

  it('the key holder prints as a placeholder everywhere', () => {
    const holder = new FragmentSessionKey(newKey().toString('base64'));
    expect(JSON.stringify({ holder })).toBe('{"holder":"[redacted]"}');
    expect(String(holder)).toBe('[redacted]');
    expect(inspect({ holder })).toContain('FragmentSessionKey([redacted])');
    expect(() => new FragmentSessionKey(Buffer.alloc(32, 7).toString('base64'))).toThrow(
      AesGcmError,
    );
  });
});

describe('Set-Cookie refresh', () => {
  const NOW = Date.parse('2026-11-15T10:00:00Z');

  it('a rotated value replaces the old one; the same value changes nothing', () => {
    const rotated = applySetCookies(JAR, ['stel_ssid=sess-two; Path=/; HttpOnly; Secure'], NOW);
    expect(rotated.changed).toBe(true);
    expect(rotated.jar.cookies.get('stel_ssid')).toBe('sess-two');
    expect(rotated.jar.pageHash).toBe('abc123abc123');
    const same = applySetCookies(JAR, ['stel_ssid=sess-one; Path=/'], NOW);
    expect(same).toEqual({ jar: JAR, changed: false });
  });

  it('expired, Max-Age=0, empty or "deleted" removes the cookie', () => {
    for (const line of [
      'stel_token=token-one; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'stel_token=x; Max-Age=0',
      'stel_token=; Path=/',
      'stel_token=deleted; Path=/',
    ]) {
      const after = applySetCookies(JAR, [line], NOW);
      expect(after.changed).toBe(true);
      expect(after.jar.cookies.has('stel_token')).toBe(false);
    }
  });

  it('another domain, a bad name or value, or a new name past the cap is ignored', () => {
    const lines = [
      'stel_ssid=evil-one; Domain=evil.test',
      'stel_ssid=evil-two; Domain=fragment.com.evil.test',
      'bad name=x',
      'stel_dt=has space',
      '=nameless',
    ];
    expect(applySetCookies(JAR, lines, NOW)).toEqual({ jar: JAR, changed: false });
    const dotted = applySetCookies(JAR, ['stel_dt=-300; Domain=.fragment.com'], NOW);
    expect(dotted.jar.cookies.get('stel_dt')).toBe('-300');
    const exact = applySetCookies(JAR, ['stel_dt=-301; Domain=FRAGMENT.com'], NOW);
    expect(exact.jar.cookies.get('stel_dt')).toBe('-301');
    // Audit I-4: only fragment.com itself; a subdomain's cookie is not this session's.
    for (const domain of ['sub.fragment.com', '.oauth.fragment.com', 'evilfragment.com']) {
      const line = `stel_ssid=other-one; Domain=${domain}`;
      expect(applySetCookies(JAR, [line], NOW)).toEqual({ jar: JAR, changed: false });
    }
    const full: FragmentJar = {
      cookies: new Map(Array.from({ length: MAX_COOKIES }, (_, i) => [`c${String(i)}`, 'v'])),
      pageHash: null,
    };
    expect(applySetCookies(full, ['extra=v'], NOW).changed).toBe(false);
    expect(applySetCookies(full, ['c0=w'], NOW).changed).toBe(true);
  });

  it('the Cookie header joins name=value pairs', () => {
    expect(cookieHeader(JAR)).toBe('stel_ssid=sess-one; stel_token=token-one');
    expect(cookieHeader({ cookies: new Map(), pageHash: null })).toBe('');
  });
});

describe('the pasted cookies (import CLI)', () => {
  it('name=value lines, a Cookie header, comments and blank lines', () => {
    expect(
      parseCookieInput('# from the browser\nstel_ssid=sess-one\n\nstel_token=token-one\n'),
    ).toEqual(
      new Map([
        ['stel_ssid', 'sess-one'],
        ['stel_token', 'token-one'],
      ]),
    );
    expect(parseCookieInput('Cookie: stel_ssid=sess-one; stel_token=token-one')).toEqual(
      new Map([
        ['stel_ssid', 'sess-one'],
        ['stel_token', 'token-one'],
      ]),
    );
  });

  it('a bad line is refused by its NUMBER, never its content', () => {
    try {
      parseCookieInput('stel_ssid=sess-one\nsecret value here');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieInputError);
      expect(String(error)).toContain('line 2');
      expect(String(error)).not.toContain('secret value');
      expect(String(error)).not.toContain('sess-one');
    }
    expect(() => parseCookieInput('\n# nothing\n')).toThrow(CookieInputError);
    const many = Array.from({ length: MAX_COOKIES + 1 }, (_, i) => `c${String(i)}=v`).join('\n');
    expect(() => parseCookieInput(many)).toThrow(CookieInputError);
  });
});
