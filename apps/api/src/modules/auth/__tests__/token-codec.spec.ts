import { createHmac } from 'node:crypto';
import { TokenCodec, TOKEN_MAX_LENGTH, type TokenPayload } from '../token-codec';

// Secrets are assembled at runtime so no secret-shaped literal sits in the source.
const fake = (...parts: string[]): string => parts.join('');
const WEB_SECRET = fake('web-secret-', 'a'.repeat(24));
const TG_SECRET = fake('tg-secret-', 'b'.repeat(24));

const codec = new TokenCodec({ JWT_ACCESS_SECRET: WEB_SECRET, TG_SESSION_SECRET: TG_SECRET });
const now = new Date('2026-06-01T12:00:00.000Z');
const nowSec = Math.floor(now.getTime() / 1000);

const tgPayload: TokenPayload = { typ: 'tg', sub: 'user1', iat: nowSec, exp: nowSec + 3600 };
const webPayload: TokenPayload = {
  typ: 'web',
  sub: 'user1',
  sid: 'fam1',
  iat: nowSec,
  exp: nowSec + 900,
};

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const mac = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body).digest('base64url');

describe('TokenCodec', () => {
  it('round-trips a tg token and a web token', () => {
    expect(codec.verify(codec.sign(tgPayload), 'tg', now)).toEqual(tgPayload);
    expect(codec.verify(codec.sign(webPayload), 'web', now)).toEqual(webPayload);
  });

  it('has the documented format: two base64url parts, no header', () => {
    const [body, sig, extra] = codec.sign(tgPayload).split('.');
    expect(extra).toBeUndefined();
    expect(JSON.parse(Buffer.from(body ?? '', 'base64url').toString())).toEqual(tgPayload);
    expect(sig).toBe(mac(TG_SECRET, body ?? ''));
  });

  it('signs tg with the Mini App secret and web with the access secret', () => {
    const [tgBody, tgSig] = codec.sign(tgPayload).split('.');
    const [webBody, webSig] = codec.sign(webPayload).split('.');
    expect(tgSig).toBe(mac(TG_SECRET, tgBody ?? ''));
    expect(webSig).toBe(mac(WEB_SECRET, webBody ?? ''));
  });

  it('rejects a tampered payload (signature kept)', () => {
    const [, sig] = codec.sign(tgPayload).split('.');
    const forged = `${b64({ ...tgPayload, sub: 'victim' })}.${sig}`;
    expect(codec.verify(forged, 'tg', now)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const [body, sig = ''] = codec.sign(tgPayload).split('.');
    const flipped = `${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`;
    expect(codec.verify(`${body}.${flipped}`, 'tg', now)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    const other = new TokenCodec({
      JWT_ACCESS_SECRET: fake('other-', 'c'.repeat(24)),
      TG_SESSION_SECRET: fake('other-', 'd'.repeat(24)),
    });
    expect(codec.verify(other.sign(tgPayload), 'tg', now)).toBeNull();
    expect(codec.verify(other.sign(webPayload), 'web', now)).toBeNull();
  });

  it('a tg token is not a web token and vice versa', () => {
    expect(codec.verify(codec.sign(tgPayload), 'web', now)).toBeNull();
    expect(codec.verify(codec.sign(webPayload), 'tg', now)).toBeNull();
  });

  it('rejects a payload relabelled to the other type', () => {
    // Attacker holds a valid tg token, rewrites typ to web and re-signs with the tg secret.
    const body = b64({ ...tgPayload, typ: 'web' });
    const forged = `${body}.${mac(TG_SECRET, body)}`;
    expect(codec.verify(forged, 'web', now)).toBeNull(); // wrong secret for web
    expect(codec.verify(forged, 'tg', now)).toBeNull(); // right secret, but typ no longer tg
  });

  it('rejects an expired token; exp == now is expired, exp == now + 1 is valid', () => {
    expect(codec.verify(codec.sign({ ...tgPayload, exp: nowSec }), 'tg', now)).toBeNull();
    expect(codec.verify(codec.sign({ ...tgPayload, exp: nowSec + 1 }), 'tg', now)).not.toBeNull();
    const later = new Date(now.getTime() + 3601 * 1000);
    expect(codec.verify(codec.sign(tgPayload), 'tg', later)).toBeNull();
  });

  it.each([
    ['empty string', ''],
    ['garbage', 'not a token'],
    ['no dot', 'abcdef'],
    ['three parts', 'a.b.c'],
    ['only a dot', '.'],
    ['empty signature', 'abc.'],
    ['empty payload', '.abc'],
    ['non-base64url characters', 'ab+/=.cd+/='],
  ])('rejects %s without throwing', (_name, token) => {
    expect(codec.verify(token, 'tg', now)).toBeNull();
    expect(codec.verify(token, 'web', now)).toBeNull();
  });

  it('rejects an over-long token', () => {
    expect(codec.verify('a'.repeat(TOKEN_MAX_LENGTH + 1), 'tg', now)).toBeNull();
    const body = b64({ ...tgPayload, sub: 'x'.repeat(TOKEN_MAX_LENGTH) });
    expect(codec.verify(`${body}.${mac(TG_SECRET, body)}`, 'tg', now)).toBeNull();
  });

  it('a signature of a different length does not throw', () => {
    const [body = ''] = codec.sign(tgPayload).split('.');
    expect(() => codec.verify(`${body}.AAAA`, 'tg', now)).not.toThrow();
    expect(codec.verify(`${body}.AAAA`, 'tg', now)).toBeNull();
    expect(codec.verify(`${body}.${'A'.repeat(200)}`, 'tg', now)).toBeNull();
  });

  it('rejects a correctly signed payload that fails the schema', () => {
    const cases: unknown[] = [
      { ...tgPayload, extra: 1 }, // strict
      { ...tgPayload, sub: '' },
      { ...tgPayload, exp: 'soon' },
      { typ: 'tg', sub: 'u' }, // missing iat/exp
      { ...tgPayload, typ: 'admin' },
      'a string',
      null,
      [],
    ];
    for (const payload of cases) {
      const body = b64(payload);
      expect(codec.verify(`${body}.${mac(TG_SECRET, body)}`, 'tg', now)).toBeNull();
    }
    const notJson = Buffer.from('{broken').toString('base64url');
    expect(codec.verify(`${notJson}.${mac(TG_SECRET, notJson)}`, 'tg', now)).toBeNull();
  });
});
