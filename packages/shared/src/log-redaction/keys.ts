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
  'authheader', // a raw header value kept in a variable
  'basicauth',
  'cookie',
  'setcookie',
  'cookies', // Fragment session cookies
  'initdata', // Telegram Mini App launch params (carry the signed hash)
  'hash',
  'signature',
  'sign',
  'signstring',
  'seed',
  'otp',
  'otpcode',
  'verificationcode',
  'phone',
  'phonenumber',
  'pwd',
  'token',
  // Pay-link and card data (phase 4): the link carries the token in its fragment, a PAN is
  // card data, and the raw bank message holds balances and card digits (D-37, D-39).
  'redirecturl',
  'payurl',
  'paylink',
  'pan',
  'cardnumber',
  'holdername', // the card holder's name (ours, but still a person's name)
  'rawtext',
  'banktext',
  // Fragment web-session cookie names (stel_ssid, stel_dt, ...) and the page hash its API
  // calls carry: any of them alone lets someone act as our session. stel_token and
  // stel_ton_token end in "token" and are caught by the suffix rule.
  'stelssid',
  'steldt',
  'fragmenthash',
  'pagehash',
]);

// High-value stems: a key CONTAINING one of these is a secret wherever the stem sits
// (`mnemonicWords`, `privateKeyPem`, `sessionCookie`, `dbPassword`, `apiKeys`). The cost is an
// occasional harmless field hidden (`cookieDomain`); the alternative is a secret in the log.
const SENSITIVE_STEMS =
  /mnemonic|seedphrase|privatekey|privkey|secretkey|secret|password|passwd|apikey|credential|cookie|enckey|encryptionkey|masterkey|signingkey|hmackey|sessionkey/;

// `accessToken`, `x-telegram-bot-api-secret-token`, `x-signature`, `refreshTokenHash`, ...
// Tested with and without a trailing plural `s`. Not a bare `sign` suffix (it would catch
// "design") and not a bare `hash` or `key` suffix: `txHash`, `idempotencyKey` and `cacheKey`
// are useful non-secrets that must stay in the logs.
const SENSITIVE_SUFFIX =
  /(token|signature|initdata|tokenhash|codehash|passwordhash|secrethash|apikeyhash)$/;

// Names the rules above could catch (or a future rule might) that are logged on purpose.
const KEEP_VISIBLE: ReadonlySet<string> = new Set([
  'idempotencykey',
  'cachekey',
  'lockkey',
  'publickey',
  'jobkey',
  'queuekey',
  'txhash',
  'tokenid',
  'orderid',
  'provider',
  'status',
  'sequence',
]);

// `SUPPLIER_UNIPIN_KEY`, `MOOGOLD_PARTNER_KEY`: env-style names ending in _KEY are credentials.
// Only the UPPER_SNAKE spelling, so camelCase `primaryKey` / `sortKey` stays readable.
const ENV_STYLE_KEY = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_KEY$/;

// `TON_MNEMONIC_ENC`, `fragment-session-enc`: sealed blobs. A bare `enc` suffix would catch
// words such as "sequence", so only the delimited form counts.
const SEALED_BLOB = /[-_]enc$/i;

// The OTP verify body is `{ nonce, code }` and the spec's OTP is exactly six digits. `code` is
// also how error envelopes and Node/Postgres errors carry INSUFFICIENT_BALANCE, ECONNREFUSED,
// -31050, 500 and SQLSTATEs (23505, 23514, 40001, 57014), which logs need: it is redacted only
// when its value looks like a one-time code.
const OTP_SHAPED = /^\d{6}$/;

function classify(key: string): boolean {
  const normalised = normalise(key);
  if (KEEP_VISIBLE.has(normalised)) return false;
  const singular = normalised.endsWith('s') ? normalised.slice(0, -1) : normalised;
  return (
    SENSITIVE_EXACT.has(normalised) ||
    SECRET_ENV_NAMES.has(normalised) ||
    SENSITIVE_STEMS.test(normalised) ||
    SENSITIVE_SUFFIX.test(normalised) ||
    SENSITIVE_SUFFIX.test(singular) ||
    ENV_STYLE_KEY.test(key) ||
    SEALED_BLOB.test(key)
  );
}

// Redaction asks about the same few hundred field names over and over (one call per object
// key and per text match); a bounded memo keeps that hot path cheap.
const verdicts = new Map<string, boolean>();
const MAX_CACHED_KEYS = 2048;

export function isSensitiveKey(key: string): boolean {
  const known = verdicts.get(key);
  if (known !== undefined) return known;
  const verdict = classify(key);
  if (verdicts.size >= MAX_CACHED_KEYS) verdicts.clear();
  verdicts.set(key, verdict);
  return verdict;
}

/** True for `code`: its verdict depends on the value (a one-time code versus an error code). */
export function isValueDependentKey(key: string): boolean {
  return normalise(key) === 'code';
}

/** Key policy plus the value-dependent `code` rule; use this wherever a value is at hand. */
export function isSensitiveField(key: string, value: unknown): boolean {
  if (isSensitiveKey(key)) return true;
  return (
    isValueDependentKey(key) &&
    (typeof value === 'string' || typeof value === 'number') &&
    OTP_SHAPED.test(String(value))
  );
}
