import { AppError } from '../../../common/exceptions/app-error';
import { InitDataVerifier } from '../init-data.verifier';
import {
  buildInitData,
  buildInitDataFields,
  defaultUser,
  fixtureBotToken,
  signFields,
  toInitData,
} from './init-data.fixtures';

const BOT = fixtureBotToken();
const MAX_AGE = 86_400;
const now = new Date('2026-06-01T12:00:00.000Z');
const nowSec = Math.floor(now.getTime() / 1000);

const verifier = new InitDataVerifier({
  TELEGRAM_BOT_TOKEN: BOT,
  TG_INITDATA_MAX_AGE_SEC: MAX_AGE,
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

const verifyCode = (initData: string): string => codeOf(() => verifier.verify(initData, now));

describe('InitDataVerifier', () => {
  it('accepts valid initData and returns user, startParam and authDate', () => {
    const result = verifier.verify(
      buildInitData({ botToken: BOT, authDate: nowSec - 10, startParam: 'ref_abcd1234' }),
      now,
    );
    expect(result).toEqual({
      user: { id: 424242n, firstName: 'Ann', username: 'ann_test', languageCode: 'ru' },
      startParam: 'ref_abcd1234',
      authDate: new Date((nowSec - 10) * 1000),
    });
  });

  it('maps every optional user field and omits start_param when absent', () => {
    const result = verifier.verify(
      buildInitData({
        botToken: BOT,
        authDate: nowSec,
        user: {
          id: 7,
          first_name: 'Bo',
          last_name: 'Li',
          username: 'bo',
          language_code: 'uz',
          photo_url: 'https://t.me/i/userpic/320/x.svg',
          is_premium: true, // unknown Telegram fields are ignored
        },
      }),
      now,
    );
    expect(result.user).toEqual({
      id: 7n,
      firstName: 'Bo',
      lastName: 'Li',
      username: 'bo',
      languageCode: 'uz',
      photoUrl: 'https://t.me/i/userpic/320/x.svg',
    });
    expect('startParam' in result).toBe(false);
  });

  it('accepts valid initData that carries a `signature` field (it is part of the check string)', () => {
    const sig = 'sig-value_abc';
    const initData = buildInitData({ botToken: BOT, authDate: nowSec, signature: sig });
    expect(new URLSearchParams(initData).get('signature')).toBe(sig);
    expect(verifyCode(initData)).toBe('NO_ERROR');
  });

  it('rejects initData whose hash was computed WITHOUT the signature field', () => {
    const withSig = buildInitDataFields({ botToken: BOT, authDate: nowSec, signature: 'sig' });
    const { signature: _omitted, ...withoutSig } = withSig;
    expect(verifyCode(toInitData(withSig, signFields(BOT, withoutSig)))).toBe('INITDATA_INVALID');
  });

  it('rejects a tampered user', () => {
    const initData = buildInitData({ botToken: BOT, authDate: nowSec });
    const params = new URLSearchParams(initData);
    params.set('user', JSON.stringify({ ...defaultUser, id: 1 }));
    expect(verifyCode(params.toString())).toBe('INITDATA_INVALID');
  });

  it('rejects a tampered start_param and an added field', () => {
    const initData = buildInitData({ botToken: BOT, authDate: nowSec, startParam: 'ref_aaaaaaaa' });
    const changed = new URLSearchParams(initData);
    changed.set('start_param', 'ref_bbbbbbbb');
    expect(verifyCode(changed.toString())).toBe('INITDATA_INVALID');
    const added = new URLSearchParams(initData);
    added.set('extra', '1');
    expect(verifyCode(added.toString())).toBe('INITDATA_INVALID');
  });

  it('rejects a tampered hash', () => {
    const params = new URLSearchParams(buildInitData({ botToken: BOT, authDate: nowSec }));
    const hash = params.get('hash') ?? '';
    params.set('hash', `${hash.startsWith('0') ? '1' : '0'}${hash.slice(1)}`);
    expect(verifyCode(params.toString())).toBe('INITDATA_INVALID');
  });

  it('rejects initData signed with another bot token', () => {
    const other = buildInitData({ botToken: fixtureBotToken('654321', 'b'), authDate: nowSec });
    expect(verifyCode(other)).toBe('INITDATA_INVALID');
  });

  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['63 chars', 'a'.repeat(63)],
    ['65 chars', 'a'.repeat(65)],
    ['non-hex', 'g'.repeat(64)],
    ['uppercase', 'A'.repeat(64)],
  ])('rejects a hash that is %s without throwing', (_name, hash) => {
    const fields = buildInitDataFields({ botToken: BOT, authDate: nowSec });
    expect(verifyCode(toInitData(fields, hash))).toBe('INITDATA_INVALID');
  });

  it('rejects missing hash, missing user, missing auth_date', () => {
    const fields = buildInitDataFields({ botToken: BOT, authDate: nowSec });
    expect(verifyCode(new URLSearchParams(fields).toString())).toBe('INITDATA_INVALID');

    expect(verifyCode(buildInitData({ botToken: BOT, authDate: nowSec, user: null }))).toBe(
      'INITDATA_INVALID',
    );

    const { auth_date: _drop, ...noDate } = fields;
    expect(verifyCode(toInitData(noDate, signFields(BOT, noDate)))).toBe('INITDATA_INVALID');
  });

  it('rejects a duplicate key even when the hash matches the last value', () => {
    const valid = buildInitData({ botToken: BOT, authDate: nowSec });
    expect(verifyCode(`${valid}&auth_date=${String(nowSec)}`)).toBe('INITDATA_INVALID');
    expect(verifyCode(`${valid}&hash=${'0'.repeat(64)}`)).toBe('INITDATA_INVALID');
  });

  describe('auth_date', () => {
    it('exactly max age is still fresh; max age + 1 s is EXPIRED', () => {
      expect(verifyCode(buildInitData({ botToken: BOT, authDate: nowSec - MAX_AGE }))).toBe(
        'NO_ERROR',
      );
      expect(verifyCode(buildInitData({ botToken: BOT, authDate: nowSec - MAX_AGE - 1 }))).toBe(
        'INITDATA_EXPIRED',
      );
    });

    it('up to 60 s in the future is tolerated; 61 s is INVALID', () => {
      expect(verifyCode(buildInitData({ botToken: BOT, authDate: nowSec + 60 }))).toBe('NO_ERROR');
      expect(verifyCode(buildInitData({ botToken: BOT, authDate: nowSec + 61 }))).toBe(
        'INITDATA_INVALID',
      );
    });

    it.each(['abc', '1.5', '-5', '', '0x10', '1e9', '1'.repeat(13)])(
      'a signed but non-integer auth_date %p is INVALID',
      (value) => {
        const fields = buildInitDataFields({ botToken: BOT, authDate: nowSec, extra: {} });
        const bad = { ...fields, auth_date: value };
        expect(verifyCode(toInitData(bad, signFields(BOT, bad)))).toBe('INITDATA_INVALID');
      },
    );

    it('a FORGED old payload is INVALID, not EXPIRED (no oracle for unsigned input)', () => {
      const fields = buildInitDataFields({ botToken: BOT, authDate: nowSec - MAX_AGE - 100 });
      expect(verifyCode(toInitData(fields, 'f'.repeat(64)))).toBe('INITDATA_INVALID');
    });
  });

  describe('user', () => {
    const signedWith = (user: unknown): string => {
      const fields = buildInitDataFields({ botToken: BOT, authDate: nowSec, user: null });
      const withUser = { ...fields, user: typeof user === 'string' ? user : JSON.stringify(user) };
      return toInitData(withUser, signFields(BOT, withUser));
    };

    it.each([
      ['not JSON', '{nope'],
      ['an array', []],
      ['null', null],
      ['id 0', { id: 0, first_name: 'A' }],
      ['negative id', { id: -5, first_name: 'A' }],
      ['float id', { id: 1.5, first_name: 'A' }],
      ['string id', { id: '12', first_name: 'A' }],
      ['unsafe integer id', { id: 2 ** 53, first_name: 'A' }],
      ['missing id', { first_name: 'A' }],
      ['missing first_name', { id: 5 }],
      ['empty first_name', { id: 5, first_name: '' }],
      ['http photo_url', { id: 5, first_name: 'A', photo_url: 'http://t.me/x.jpg' }],
      ['javascript photo_url', { id: 5, first_name: 'A', photo_url: 'javascript:alert(1)' }],
      ['non-string username', { id: 5, first_name: 'A', username: 5 }],
    ])('signed but with %s -> INVALID', (_name, user) => {
      expect(verifyCode(signedWith(user))).toBe('INITDATA_INVALID');
    });
  });
});
