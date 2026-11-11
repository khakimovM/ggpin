import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
// Binds the blob to its purpose: a blob made with the same key for something else never opens here.
const AAD = Buffer.from('ggpin/bank-feed-session/v1', 'utf8');
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type SessionCryptoProblem = 'BAD_KEY' | 'BAD_BLOB';

/**
 * Why the bank-feed session cannot be used. The message never carries a value (the key, the
 * blob or the session): it is safe for boot errors and logs.
 */
export class SessionCryptoError extends Error {
  constructor(readonly problem: SessionCryptoProblem) {
    super(
      problem === 'BAD_KEY'
        ? 'BANK_FEED_ENC_KEY must be 32 random bytes written in base64'
        : 'BANK_FEED_SESSION_ENC cannot be opened with BANK_FEED_ENC_KEY (wrong key or damaged blob)',
    );
    this.name = 'SessionCryptoError';
  }
}

// Canonical base64 only: a value that merely decodes (whitespace, missing padding) is refused,
// so a truncated copy-paste is an error, not a shorter key.
function decodeBase64(value: string): Buffer | null {
  if (!BASE64.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

/** The AES-256 key from BANK_FEED_ENC_KEY (base64 of exactly 32 bytes). */
export function parseSessionKey(base64Key: string): Buffer {
  const key = decodeBase64(base64Key);
  if (key?.length !== KEY_BYTES) throw new SessionCryptoError('BAD_KEY');
  // A key of one repeated byte (all zeros from a broken generator, "AAAA...") is not random.
  if (key.every((byte) => byte === key[0])) throw new SessionCryptoError('BAD_KEY');
  return key;
}

/**
 * AES-256-GCM: base64(iv(12) | tag(16) | ciphertext), docs/05 §4. A fresh random IV per call.
 * Only the login CLI encrypts; the worker only decrypts, in memory.
 */
export function encryptSession(session: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new SessionCryptoError('BAD_KEY');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(session, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** The session string, or SessionCryptoError('BAD_BLOB') for a wrong key or any damage. */
export function decryptSession(blob: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new SessionCryptoError('BAD_KEY');
  const bytes = decodeBase64(blob);
  if (bytes === null || bytes.length <= IV_BYTES + TAG_BYTES) {
    throw new SessionCryptoError('BAD_BLOB');
  }
  try {
    // An explicit tag length: GCM must never accept a shortened tag (D-52).
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(AAD);
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    // The OpenSSL message says nothing useful and must not reach a log as if it did.
    throw new SessionCryptoError('BAD_BLOB');
  }
}
