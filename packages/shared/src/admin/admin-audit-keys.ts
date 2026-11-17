// Which keys of an audit row's free JSON (`before` / `after`) the admin panel may show (docs/04
// "Admin" — audit; review M-2 / N2). The ONE classification: the audit redactor and the response
// schema test both call `isAuditSecretKey`. Three layers, in this order:
//   1. allowlist — public facts that would otherwise look like secrets (a tx hash, `otpVerified`);
//   2. whole-key deny-list — known secret names written by the services today;
//   3. token rule — a NEW key with a secret word among its tokens is hidden too (fail closed).
//   4. substring rule — roots that are rarely part of a harmless word (`password`, `token`,
//      `seed`, ...): a key written as one lower-case word (`bottoken`) is caught too. Fail
//      closed wins over a harmless name: `seeded` or `tokenCount` would be hidden (no service
//      writes such a key today; an allowlist entry would show one).
// `hash`, `code`, `otp`, `pan` and `session` are words, never substrings: they occur inside harmless
// names (`txHash`, `errorCode`, `otpVerified`, `company`, `expand`, `revokedSessions`).

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
  // S1 re-audit K1 / S4 audit SA-S4-2: names the services do not write today, hidden if they appear.
  'seed',
  'passphrase',
  'authkey',
  'initdata',
  'signature',
  'cardnumber',
  'pan',
  'cvv',
  'cvc',
  'jwt',
  'authorization',
  'bearer',
  'privkey',
  'idempotencykey',
  'sessionstring',
  // S4 re-audit SA-S4R-1: card numbers and PINs under short names. `pin` is a WORD (`cardPin`,
  // `pin_code`), never a substring: `pinned` and `spinner` stay visible.
  'cardno',
  'cardnum',
  'pin',
  'cvv2',
  'creds',
]);

/** Roots hidden wherever they occur in the normalised key (none is part of a harmless word). */
export const AUDIT_SECRET_SUBSTRINGS = Object.freeze([
  'mnemonic',
  'password',
  'passphrase',
  'secret',
  'privatekey',
  'apikey',
  'cookie',
  'initdata',
  'sessionstring',
  'cardnumber',
  // S4 re-audit SA-S4R-1
  'token',
  'seed',
  'privkey',
  'enckey',
  'accesskey',
  'signingkey',
  'credential',
]);

const VISIBLE = normalisedSet(AUDIT_VISIBLE_KEYS);
const SECRET = normalisedSet(AUDIT_SECRET_KEYS);
const SECRET_TOKENS: ReadonlySet<string> = new Set(AUDIT_SECRET_TOKENS);

const singular = (word: string): string[] => [
  word,
  ...(word.endsWith('s') ? [word.slice(0, -1)] : []),
  ...(word.endsWith('es') ? [word.slice(0, -2)] : []),
];

/** True when a token of `key`, or a run of adjacent tokens (`api`+`key`), is one of `runs`. */
function hasTokenRun(key: string, runs: ReadonlySet<string>): boolean {
  const tokens = auditKeyTokens(key);
  for (let start = 0; start < tokens.length; start += 1) {
    for (let end = start + 1; end <= tokens.length; end += 1) {
      if (singular(tokens.slice(start, end).join('')).some((word) => runs.has(word))) return true;
    }
  }
  return false;
}

/** True when the value under `key` must never reach the panel (for any role). */
export function isAuditSecretKey(key: string): boolean {
  const normalised = normaliseAuditKey(key);
  if (VISIBLE.has(normalised)) return false;
  if (SECRET.has(normalised) || hasTokenRun(key, SECRET_TOKENS)) return true;
  return AUDIT_SECRET_SUBSTRINGS.some((root) => normalised.includes(root));
}

const IP_KEYS = normalisedSet(['ip', 'sshClient', 'remoteAddr', 'ipAddress', 'forwardedFor']);
/** Words or adjacent-word runs that make a key an IP field (`clientIp`, `xForwardedFor`). */
const IP_TOKEN_RUNS: ReadonlySet<string> = new Set([
  'ip',
  'ipaddress',
  'remoteaddr',
  'forwardedfor',
  // S4 re-audit SA-S4R-1
  'remoteaddress',
  'peeraddress',
  'clientaddress',
  'ipv4',
  'ipv6',
  'ipaddr',
  'forwarded',
]);
const ADMIN_IDENTITY_KEYS = normalisedSet(['osUser']);
const BANK_MESSAGE_KEYS = normalisedSet(['text', 'rawText', 'balanceAfterTiyin', 'channel']);

/** An IP field inside audit JSON: in full to OWNER only (`audit.ipFull`), masked to others. */
export function isAuditIpKey(key: string): boolean {
  return IP_KEYS.has(normaliseAuditKey(key)) || hasTokenRun(key, IP_TOKEN_RUNS);
}

const TELEGRAM_ID_RUNS: ReadonlySet<string> = new Set(['telegramid', 'chatid', 'fromid']);
const TELEGRAM_WORDS: ReadonlySet<string> = new Set(['telegram', 'tg']);
const ID_WORDS: ReadonlySet<string> = new Set(['id', 'ids']);

/**
 * Who an admin is outside the panel (SA-S4-3): a Telegram id inside audit JSON is masked: a key
 * with `telegram` or `tg` among its words that ends in `id`/`ids` (`tgUserId`, `telegram_user_id`),
 * or one naming `telegramId`, `chatId` or `fromId` anywhere (SA-S4R-1). The CLI's `osUser` is
 * `null`. Both for a reader without the OWNER's identity view; keys stay, only the values change.
 */
export function isAuditTelegramIdKey(key: string): boolean {
  const tokens = auditKeyTokens(key);
  const last = tokens[tokens.length - 1];
  if (last !== undefined && ID_WORDS.has(last) && tokens.some((word) => TELEGRAM_WORDS.has(word))) {
    return true;
  }
  return hasTokenRun(key, TELEGRAM_ID_RUNS);
}

export function isAuditOsUserKey(key: string): boolean {
  return ADMIN_IDENTITY_KEYS.has(normaliseAuditKey(key));
}

/** A bank message field inside audit JSON: OWNER only (`payments.bankMessageRaw`), else `null`. */
export function isAuditBankMessageKey(key: string): boolean {
  return BANK_MESSAGE_KEYS.has(normaliseAuditKey(key));
}
