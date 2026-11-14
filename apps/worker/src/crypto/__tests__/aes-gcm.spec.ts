import { randomBytes } from 'node:crypto';
import { AesGcmError, openAesGcm, parseAesKey, sealAesGcm } from '../aes-gcm';

const newKey = () => randomBytes(32).toString('base64');
const PLAIN = 'plaintext of a test, not a secret';

function problemOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AesGcmError) return `${error.problem}: ${error.message}`;
    throw error;
  }
  throw new Error('expected an AesGcmError');
}

describe('AES-256-GCM with a purpose (AAD)', () => {
  it('round-trips, with a fresh IV every time', () => {
    const key = parseAesKey(newKey());
    const a = sealAesGcm(Buffer.from(PLAIN), key, 'purpose/a');
    const b = sealAesGcm(Buffer.from(PLAIN), key, 'purpose/a');
    expect(a).not.toBe(b);
    expect(openAesGcm(a, key, 'purpose/a').toString()).toBe(PLAIN);
  });

  it('a wrong key, another purpose or any damage is BAD_BLOB, with no value in the message', () => {
    const key = parseAesKey(newKey());
    const blob = sealAesGcm(Buffer.from(PLAIN), key, 'ggpin/ton-mnemonic/v1/testnet');
    const other = parseAesKey(newKey());
    const bytes = Buffer.from(blob, 'base64');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const cases = [
      () => openAesGcm(blob, other, 'ggpin/ton-mnemonic/v1/testnet'),
      () => openAesGcm(blob, key, 'ggpin/ton-mnemonic/v1/mainnet'),
      () => openAesGcm(bytes.toString('base64'), key, 'ggpin/ton-mnemonic/v1/testnet'),
      () => openAesGcm(blob.slice(0, 20), key, 'ggpin/ton-mnemonic/v1/testnet'),
      () => openAesGcm(` ${blob}`, key, 'ggpin/ton-mnemonic/v1/testnet'),
    ];
    for (const open of cases) {
      const message = problemOf(open);
      expect(message).toMatch(/^BAD_BLOB: /);
      expect(message).not.toContain(PLAIN);
      expect(message).not.toContain(blob.slice(0, 12));
    }
  });

  it('a key must be 32 random bytes in canonical base64', () => {
    for (const bad of [
      randomBytes(16).toString('base64'),
      Buffer.alloc(32).toString('base64'),
      Buffer.alloc(32, 7).toString('base64'),
      `${newKey()} `,
      newKey().replace(/=+$/, ''),
      'change-me',
    ]) {
      const message = problemOf(() => parseAesKey(bad));
      expect(message).toMatch(/^BAD_KEY: /);
      expect(message).not.toContain(bad);
    }
    expect(() => sealAesGcm(Buffer.from(PLAIN), randomBytes(16), 'p')).toThrow(AesGcmError);
  });
});
