import { randomBytes } from 'node:crypto';
import {
  SessionCryptoError,
  decryptSession,
  encryptSession,
  parseSessionKey,
} from '../session-crypto';

// A made-up session string (the real one is ~420 base64url chars, S0); never a real session.
const SESSION = `TESTSESSION_${'A'.repeat(400)}`;
const KEY_TEXT = randomBytes(32).toString('base64');

function problemOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof SessionCryptoError ? error.problem : 'OTHER';
  }
}

describe('session-crypto (AES-256-GCM, iv(12) | tag(16) | ciphertext)', () => {
  const key = parseSessionKey(KEY_TEXT);

  it('round-trips, with a fresh IV every time', () => {
    const a = encryptSession(SESSION, key);
    const b = encryptSession(SESSION, key);
    expect(a).not.toBe(b);
    expect(decryptSession(a, key)).toBe(SESSION);
    expect(decryptSession(b, key)).toBe(SESSION);
    const bytes = Buffer.from(a, 'base64');
    expect(bytes.length).toBe(12 + 16 + Buffer.byteLength(SESSION));
    expect(a).not.toContain('TESTSESSION');
  });

  it('a wrong key or any damaged byte is BAD_BLOB, never a garbled session', () => {
    const blob = encryptSession(SESSION, key);
    const other = parseSessionKey(randomBytes(32).toString('base64'));
    expect(() => decryptSession(blob, other)).toThrow(SessionCryptoError);
    const bytes = Buffer.from(blob, 'base64');
    for (const at of [0, 12, 28, bytes.length - 1]) {
      const bad = Buffer.from(bytes);
      bad[at] = (bad[at] ?? 0) ^ 0x01;
      expect(problemOf(() => decryptSession(bad.toString('base64'), key))).toBe('BAD_BLOB');
    }
    expect(() => decryptSession(bytes.subarray(0, 28).toString('base64'), key)).toThrow(
      SessionCryptoError,
    );
    expect(() => decryptSession(`${blob} `, key)).toThrow(SessionCryptoError);
    expect(() => decryptSession('not base64!', key)).toThrow(SessionCryptoError);
  });

  it('the key is exactly 32 bytes of canonical base64', () => {
    expect(problemOf(() => parseSessionKey(randomBytes(16).toString('base64')))).toBe('BAD_KEY');
    expect(() => parseSessionKey(KEY_TEXT.replace(/=+$/, ''))).toThrow(SessionCryptoError);
    expect(() => parseSessionKey(`${KEY_TEXT}\n`)).toThrow(SessionCryptoError);
    expect(() => encryptSession(SESSION, randomBytes(16))).toThrow(SessionCryptoError);
  });

  it('D-52: a key of one repeated byte (all zeros, AAAA...) is BAD_KEY, not a key', () => {
    expect(problemOf(() => parseSessionKey(Buffer.alloc(32).toString('base64')))).toBe('BAD_KEY');
    expect(problemOf(() => parseSessionKey(Buffer.alloc(32, 0xff).toString('base64')))).toBe(
      'BAD_KEY',
    );
    expect(problemOf(() => parseSessionKey(KEY_TEXT))).toBeNull();
  });

  it('error messages never carry the key, the blob or the session', () => {
    const blob = encryptSession(SESSION, key);
    const other = parseSessionKey(randomBytes(32).toString('base64'));
    try {
      decryptSession(blob, other);
      throw new Error('should have failed');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain(blob.slice(0, 16));
      expect(message).not.toContain(KEY_TEXT.slice(0, 16));
      expect(message).not.toContain('TESTSESSION');
    }
  });
});
