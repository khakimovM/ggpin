// Which keys of an audit row's free JSON (`before` / `after`) the admin panel may show (docs/04
// "Admin" — audit; review M-2 / N2). The ONE classification: the audit redactor and the response
// schema test both call `isAuditSecretKey`. Three layers, in this order:
//   1. allowlist — public facts that would otherwise look like secrets (a tx hash, `otpVerified`);
//   2. whole-key deny-list — known secret names written by the services today;
//   3. token rule — a NEW key with a secret word among its tokens is hidden too (fail closed).
// A plain substring rule is not used: `hash`, `code`, `otp` and `session` occur inside harmless
// names (`txHash`, `errorCode`, `otpVerified`, `revokedSessions`).

/** Lower-case, without `_`, `-` and spaces: `api_key`, `API-KEY` and `apiKey` are one key. */
export function normaliseAuditKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

/** The words of a key: camelCase, PascalCase, snake_case and kebab-case are split alike. */
export function auditKeyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[-_\s.]+/)
    .filter((token) => token !== '');
}

const normalisedSet = (keys: readonly string[]): ReadonlySet<string> =>
  new Set(keys.map(normaliseAuditKey));

/** Always shown, before any deny rule (public chain facts, flags and reason codes). */
export const AUDIT_VISIBLE_KEYS = Object.freeze([
  'otpVerified',
  'otpRequired',
  'txHash',
  'txLt',
  'lt',
  'returnTxHash',
  'returnLt',
  'extMsgHash',
  'consumingTxHash',
  'proofDigest',
  'recentAutoTopups',
  'statusReason',
  'rejectReason',
  'errorCode',
  'reasonCode',
  'statusCode',
  'countryCode',
]);

/** Hidden by their whole (normalised) name. */
export const AUDIT_SECRET_KEYS = Object.freeze([
  // card data
  'pan',
  'fullPan',
  'cardPan',
  'cardNumber',
  // one-time and redeemable codes
  'code',
  'otp',
  'otpCode',
  'codeHash',
  'challengeId',
  'bonusCode',
  'promoCode',
  'discountCode',
  // keys and secrets
  'mnemonic',
  'seed',
  'privateKey',
  'secretKey',
  'apiKey',
  'apiHash',
  'password',
  'passphrase',
  // sessions
  'cookie',
  'cookies',
  'session',
  'sessionString',
  'bankFeedSession',
  'authKey',
  'initData',
  // tokens and their hashes
  'token',
  'accessToken',
  'refreshToken',
  'payToken',
  'tokenHash',
  'payTokenHash',
  'refreshHash',
  'requestHash',
  'textSha256',
  'idempotencyKey',
  // provider references
  'providerRef',
  'recheckedProviderRef',
  'providerTxnId',
  'raw',
  // signatures and signed messages
  'signature',
  'boc',
  'signedBoc',
  'payloadBoc',
  // the CARD_ADD verification amount (it proves card ownership)
  'verifyAmountTiyin',
]);

/**
 * A key with one of these among its tokens (or a run of adjacent tokens, `api`+`key`) is hidden.
 * `otp`, `code` and `hash` are here as WORDS, not substrings: `fooHash` is hidden until it is
 * allowlisted, `phashion` is not. `session` is not here: `revokedSessions` is a count to show.
 */
export const AUDIT_SECRET_TOKENS = Object.freeze([
  'secret',
  'password',
  'mnemonic',
  'cookie',
  'token',
  'boc',
  'apikey',
  'privatekey',
  'verifyamount',
  'providerref',
  'providertxn',
  'otp',
  'code',
  'hash',
]);

const VISIBLE = normalisedSet(AUDIT_VISIBLE_KEYS);
const SECRET = normalisedSet(AUDIT_SECRET_KEYS);
const SECRET_TOKENS: ReadonlySet<string> = new Set(AUDIT_SECRET_TOKENS);

const singular = (word: string): string[] => [
  word,
  ...(word.endsWith('s') ? [word.slice(0, -1)] : []),
  ...(word.endsWith('es') ? [word.slice(0, -2)] : []),
];

function hasSecretToken(key: string): boolean {
  const tokens = auditKeyTokens(key);
  for (let start = 0; start < tokens.length; start += 1) {
    for (let end = start + 1; end <= tokens.length; end += 1) {
      const run = tokens.slice(start, end).join('');
      if (singular(run).some((word) => SECRET_TOKENS.has(word))) return true;
    }
  }
  return false;
}

/** True when the value under `key` must never reach the panel (for any role). */
export function isAuditSecretKey(key: string): boolean {
  const normalised = normaliseAuditKey(key);
  if (VISIBLE.has(normalised)) return false;
  return SECRET.has(normalised) || hasSecretToken(key);
}

const IP_KEYS = normalisedSet(['ip', 'sshClient', 'remoteAddr']);
const BANK_MESSAGE_KEYS = normalisedSet(['text', 'rawText', 'balanceAfterTiyin', 'channel']);

/** An IP field inside audit JSON: in full to OWNER only (`audit.ipFull`), masked to others. */
export function isAuditIpKey(key: string): boolean {
  return IP_KEYS.has(normaliseAuditKey(key));
}

/** A bank message field inside audit JSON: OWNER only (`payments.bankMessageRaw`), else `null`. */
export function isAuditBankMessageKey(key: string): boolean {
  return BANK_MESSAGE_KEYS.has(normaliseAuditKey(key));
}
