import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM for secrets kept at rest in the worker's environment (rules/60: "encrypted at rest,
// decrypted in memory only in the worker"). The blob format is the one the bank-feed session
// already uses (session-crypto.ts, docs/05 §4): base64(iv(12) | tag(16) | ciphertext). The caller
// names the PURPOSE as additional authenticated data, so a blob made with the same key for one
// purpose (the TON mnemonic of mainnet, say) never opens for another (the testnet one, a session).
// The bank-feed module keeps its own copy on purpose (its blobs and messages are fixed, D-52).

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type AesGcmProblem = 'BAD_KEY' | 'BAD_BLOB';

/**
 * Why a key or a blob cannot be used. The message never carries a value (the key, the blob or the
 * plaintext), so it is safe for boot errors and logs; callers prefix the variable name.
 */
export class AesGcmError extends Error {
  constructor(readonly problem: AesGcmProblem) {
    super(
      problem === 'BAD_KEY'
        ? 'must be 32 random bytes written in base64'
        : 'cannot be opened with this key (wrong key, another purpose or a damaged blob)',
    );
    this.name = 'AesGcmError';
  }
}

/** Canonical base64 only: a value that merely decodes (whitespace, missing padding) is refused. */
function decodeCanonicalBase64(value: string): Buffer | null {
  if (!BASE64.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

/** The AES-256 key from its base64 text (exactly 32 bytes, not one repeated byte). */
export function parseAesKey(base64Key: string): Buffer {
  const key = decodeCanonicalBase64(base64Key);
  if (key?.length !== KEY_BYTES) throw new AesGcmError('BAD_KEY');
  // All zeros from a broken generator, "AAAA...": not a random key.
  if (key.every((byte) => byte === key[0])) throw new AesGcmError('BAD_KEY');
  return key;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new AesGcmError('BAD_KEY');
}

/** Encrypts with a fresh random IV. `purpose` is bound as AAD and must be given again to open. */
export function sealAesGcm(plain: Buffer, key: Buffer, purpose: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/**
 * The plaintext as a Buffer (the caller can zero it after use), or AesGcmError('BAD_BLOB') for a
 * wrong key, another purpose or any damage.
 */
export function openAesGcm(blob: string, key: Buffer, purpose: string): Buffer {
  assertKey(key);
  const bytes = decodeCanonicalBase64(blob);
  if (bytes === null || bytes.length <= IV_BYTES + TAG_BYTES) throw new AesGcmError('BAD_BLOB');
  try {
    // An explicit tag length: GCM must never accept a shortened tag (D-52).
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    // The OpenSSL message says nothing useful and must not reach a log as if it did.
    throw new AesGcmError('BAD_BLOB');
  }
}
