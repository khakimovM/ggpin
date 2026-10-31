import { ALL_SECRET_ENV_NAMES } from '../env-secrets';

export const REDACTED = '[Redacted]';

// Compared after normalisation (lower-case, no `-`, `_` or spaces), so `apiKey`, `api_key`,
// `X-Api-Key` and `APIKEY` are one entry.
const normalise = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');

// The env-variable names come from the shared secret lists, so a secret added there is
// redacted in logs without touching this file.
const SECRET_ENV_NAMES: ReadonlySet<string> = new Set(ALL_SECRET_ENV_NAMES.map(normalise));

const SENSITIVE_EXACT: ReadonlySet<string> = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'cookies', // Fragment session cookies
  'initdata', // Telegram Mini App launch params (carry the signed hash)
  'hash',
  'signature',
  'sign',
  'signstring',
  'mnemonic',
  'seed',
  'seedphrase',
  'apikey',
  'password',
  'secret',
  'token',
  'tokens',
  'otp',
  'otpcode',
  'verificationcode',
  'phone',
  'phonenumber',
  'privatekey',
]);

// `accessToken`, `x-telegram-bot-api-secret-token`, `clientSecret`, `x-signature`,
// `dbPassword`, `JWT_ACCESS_SECRET`, `WALLET_ENC_KEY`, `refreshTokenHash`, ... Not a bare
// `sign` suffix (it would catch "design") and not a bare `hash` or `key` suffix: `txHash`,
// `idempotencyKey` and `cacheKey` are useful non-secrets that must stay in the logs.
const SENSITIVE_SUFFIXES: readonly string[] = [
  'token',
  'secret',
  'apikey',
  'password',
  'privatekey',
  'privkey',
  'secretkey',
  'enckey',
  'signature',
  'initdata',
  'mnemonic',
  'seedphrase',
  // Stored digests of credentials: tokenHash, codeHash, passwordHash, refreshTokenHash.
  'tokenhash',
  'codehash',
  'passwordhash',
  'secrethash',
  'apikeyhash',
];

// `TON_MNEMONIC_ENC`, `fragment-session-enc`: sealed blobs. A bare `enc` suffix would catch
// words such as "sequence", so only the delimited form counts.
const SEALED_BLOB = /[-_]enc$/i;

// The OTP verify body is `{ nonce, code }`. `code` is also how error envelopes and Node
// errors carry `INSUFFICIENT_BALANCE` / `ECONNREFUSED` / `-31050` / `500`, which logs need,
// so it is redacted only when its value looks like a one-time code.
const OTP_SHAPED = /^\d{4,8}$/;

export function isSensitiveKey(key: string): boolean {
  const normalised = normalise(key);
  return (
    SENSITIVE_EXACT.has(normalised) ||
    SECRET_ENV_NAMES.has(normalised) ||
    SENSITIVE_SUFFIXES.some((suffix) => normalised.endsWith(suffix)) ||
    SEALED_BLOB.test(key)
  );
}

/** Key policy plus the value-dependent `code` rule; use this wherever a value is at hand. */
export function isSensitiveField(key: string, value: unknown): boolean {
  if (isSensitiveKey(key)) return true;
  return (
    normalise(key) === 'code' &&
    (typeof value === 'string' || typeof value === 'number') &&
    OTP_SHAPED.test(String(value))
  );
}
