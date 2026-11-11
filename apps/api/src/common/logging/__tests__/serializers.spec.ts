import { REDACTED } from '@repo/shared';
import { MAX_PATH_LENGTH, loggablePath, redactLoginNonce, serializeRequest } from '../serializers';

const NONCE = 'n0nce-VALUE_abcdef123456';
const PREFIX = '/api/v1/auth/telegram/status';

describe('redactLoginNonce', () => {
  it('replaces the nonce segment with the redaction marker', () => {
    expect(redactLoginNonce(`${PREFIX}/${NONCE}`)).toBe(`${PREFIX}/${REDACTED}`);
  });

  it('keeps a trailing slash', () => {
    expect(redactLoginNonce(`${PREFIX}/${NONCE}/`)).toBe(`${PREFIX}/${REDACTED}/`);
  });

  it('matches the prefix case-insensitively and with any version prefix', () => {
    expect(redactLoginNonce(`/API/V1/Auth/Telegram/STATUS/${NONCE}`)).toBe(
      `/API/V1/Auth/Telegram/STATUS/${REDACTED}`,
    );
    expect(redactLoginNonce(`/api/v2/auth/telegram/status/${NONCE}`)).toBe(
      `/api/v2/auth/telegram/status/${REDACTED}`,
    );
    expect(redactLoginNonce(`/auth/telegram/status/${NONCE}`)).toBe(
      `/auth/telegram/status/${REDACTED}`,
    );
  });

  it('sees through percent-encoding of letters and of the slash', () => {
    const encodedLetters = '/api/v1/auth/%74elegram/%73tatus/' + NONCE;
    expect(redactLoginNonce(encodedLetters)).not.toContain(NONCE);
    expect(redactLoginNonce(`/api/v1/auth%2Ftelegram%2fstatus%2F${NONCE}`)).toBe(
      `/api/v1/auth/telegram/status/${REDACTED}`,
    );
    expect(redactLoginNonce(`${PREFIX}/%6e0nce-VALUE_abcdef123456`)).not.toContain(NONCE);
  });

  it('redacts even when the path holds a malformed escape', () => {
    const out = redactLoginNonce(`/api/v1/auth/telegram%2fstatus/%zz${NONCE}`);
    expect(out).not.toContain(NONCE);
    expect(out).toContain(REDACTED);
    expect(redactLoginNonce(`${PREFIX}/${NONCE}%`)).not.toContain(NONCE);
  });

  it('swallows extra segments after the nonce', () => {
    const out = redactLoginNonce(`${PREFIX}/${NONCE}/extra/more`);
    expect(out).toBe(`${PREFIX}/${REDACTED}`);
  });

  it('leaves other paths alone', () => {
    for (const path of [
      '/api/v1/auth/telegram/start',
      '/api/v1/auth/telegram/verify',
      `${PREFIX}`,
      `${PREFIX}/`,
      '/api/v1/orders/123',
      '/api/v1/auth/telegram/webapp',
      '/api/v1/auth/%zz',
    ]) {
      expect(redactLoginNonce(path)).toBe(path);
    }
  });
});

describe('loggablePath', () => {
  it('cuts the query string and the fragment, with or without a nonce', () => {
    expect(loggablePath('/api/v1/orders?token=abc#x')).toBe('/api/v1/orders');
    expect(loggablePath(`${PREFIX}/${NONCE}?token=abc`)).toBe(`${PREFIX}/${REDACTED}`);
    expect(loggablePath(`${PREFIX}/${NONCE}/?a=1&b=2`)).toBe(`${PREFIX}/${REDACTED}/`);
    expect(loggablePath(`${PREFIX}/${NONCE}#frag`)).toBe(`${PREFIX}/${REDACTED}`);
  });

  it('does not let a query string hide or fake the nonce segment', () => {
    // The nonce sits after a "?" here, so it is the query and is cut as such.
    expect(loggablePath(`${PREFIX}?x=${NONCE}`)).toBe(PREFIX);
  });
});

describe('serializeRequest', () => {
  it('logs the redacted path and no nonce anywhere in the result', () => {
    const out = serializeRequest({
      id: 'req-1',
      method: 'GET',
      url: `${PREFIX}/${NONCE}?x=1`,
      headers: { 'user-agent': 'jest' },
    });
    expect(out).toMatchObject({ method: 'GET', path: `${PREFIX}/${REDACTED}` });
    expect(JSON.stringify(out)).not.toContain(NONCE);
  });

  it('cuts the path at 128 characters (an over-long id must not bloat the log, R-6)', () => {
    const url = `/api/v1/payments/pay/${'a'.repeat(8_000)}`;
    const out = serializeRequest({ id: 'req-2', method: 'GET', url, headers: {} });
    expect(MAX_PATH_LENGTH).toBe(128);
    expect(out).toMatchObject({ path: url.slice(0, 128) });
  });
});
