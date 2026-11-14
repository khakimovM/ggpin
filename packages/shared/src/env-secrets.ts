// Names (never values) of the secret environment variables, and the pure policy helpers that
// apps/api and apps/worker share. Nothing here reads `process.env`: callers pass a source in.
//
// One list per owner process so that (a) each app refuses to boot when it can see another
// process's secrets, (b) the production placeholder rule covers every issued secret, and
// (c) log redaction (log-redaction/keys.ts) derives its key names from here, so a new secret
// added to a list is redacted in logs automatically.

// Secrets that only apps/worker may hold (CLAUDE.md §5.7, docs/10-SECURITY.md). If the API
// process can see one, a compromised API could move money out of the hot wallet.
export const WORKER_ONLY_SECRETS = [
  'TON_MNEMONIC_ENC',
  'WALLET_ENC_KEY',
  'FRAGMENT_SESSION_ENC_KEY',
  'TON_API_KEY',
  'RESELLER_STARS_API_KEY',
  // Bank-feed Telegram user session (MTProto) that reads the card bots; an API that could
  // see it could read or impersonate the account that confirms customer payments.
  'BANK_FEED_API_HASH',
  'BANK_FEED_SESSION_ENC',
  'BANK_FEED_ENC_KEY',
  // D-52 D3: the Docker-secret file holding BANK_FEED_ENC_KEY in production (a path, but where
  // the key lives is the worker's business only).
  'BANK_FEED_ENC_KEY_FILE',
  // The Docker-secret file holding WALLET_ENC_KEY (the key of the TON mnemonic blob, D-56 (8)):
  // where the wallet key lives is the worker's business only (named explicitly, phase 5 S4).
  'WALLET_ENC_KEY_FILE',
] as const;

// Secrets that only apps/api may hold. The worker refuses to boot with one: a worker that
// can see payment-provider keys or session-signing secrets widens what a compromise of the
// wallet-holding process can forge. TELEGRAM_BOT_TOKEN is API-only per docs/10-SECURITY.md
// ("Bot tokeni ... faqat api env"); worker alerts travel through the API's tg-outbox queue
// (docs/02-ARCHITECTURE.md), so the worker does not need the token.
export const API_ONLY_SECRETS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'TG_SESSION_SECRET',
  'TELEGRAM_WEBHOOK_SECRET',
  'OTP_PEPPER',
  'TELEGRAM_BOT_TOKEN',
  'CLICK_SECRET_KEY',
  'PAYME_KEY',
  'UZUM_SECRET',
  'RAHMAT_SECRET',
  // HMAC pepper of the pay-link capability token hash (D-39).
  'PAY_TOKEN_PEPPER',
] as const;

export const MIN_GENERATED_SECRET_LENGTH = 32;

// ---- Production placeholder rule groups ---------------------------------------------------
// "Generated": we create them, so they must be long and random in production.
// "Issued": a third party creates them; their length is not ours to dictate (a valid Click
// key may be shorter than 32 chars), so only placeholders are rejected.

export const API_PRODUCTION_GENERATED_SECRETS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'TG_SESSION_SECRET',
  'TELEGRAM_WEBHOOK_SECRET',
  'OTP_PEPPER',
  'PAY_TOKEN_PEPPER',
] as const;

export const API_PRODUCTION_ISSUED_CREDENTIALS = [
  'TELEGRAM_BOT_TOKEN',
  'CLICK_SECRET_KEY',
  'PAYME_KEY',
  'UZUM_SECRET',
  'RAHMAT_SECRET',
] as const;

export const WORKER_PRODUCTION_GENERATED_SECRETS = [
  'TON_MNEMONIC_ENC',
  'WALLET_ENC_KEY',
  'FRAGMENT_SESSION_ENC_KEY',
  'BANK_FEED_SESSION_ENC',
  'BANK_FEED_ENC_KEY',
] as const;

export const WORKER_PRODUCTION_ISSUED_CREDENTIALS = [
  'TON_API_KEY',
  'RESELLER_STARS_API_KEY',
  'BANK_FEED_API_HASH',
] as const;

/** Every secret env name the system knows; log redaction derives its key names from this. */
export const ALL_SECRET_ENV_NAMES: readonly string[] = [
  ...WORKER_ONLY_SECRETS,
  ...API_ONLY_SECRETS,
];

// ---- Worker-secret detection for the API ---------------------------------------------------
// The exact list above misses a new worker secret that someone forgets to add (e.g.
// FAZERCARDS_API_KEY). The API therefore also refuses by name shape, in two narrow rules.
// The API must still boot in a developer shell full of unrelated credentials (GITHUB_TOKEN,
// NPM_TOKEN, AWS_SECRET_ACCESS_KEY, SSH_PRIVATE_KEY ...) and with its own legitimate
// secret-ish names (COOKIE_SECRET, JWT_PRIVATE_KEY), so neither rule is a bare "looks secret".

/**
 * Env-name prefixes owned by apps/worker: the TON wallet and its API providers, the Fragment
 * session, the Stars reseller, and every supplier / game adapter (ProductRoute.adapter in
 * packages/db/prisma/schema.prisma and the supplier table in docs/06-FULFILLMENT.md). Add the
 * prefix of every new adapter here in the same change that adds its secrets.
 */
export const WORKER_ENV_PREFIXES = [
  'TON_',
  'TONCENTER_',
  'TONAPI_',
  'WALLET_',
  'HOT_WALLET_',
  'FRAGMENT_',
  'STEL_', // Fragment web-session cookie names (stel_ssid, stel_dt, ...)
  'RESELLER_',
  // Bank-feed listener. Only its secret-shaped names are refused in the API: the tunables the
  // API reads itself (BANK_FEED_HEARTBEAT_MAX_AGE_SEC) are not secrets and stay allowed.
  'BANK_FEED_',
  'SUPPLIER_',
  'FAZERCARDS_',
  'WDGZONE_',
  'MOOGOLD_',
  'UNIPIN_',
  'SMILEONE_',
  'STEAM_',
  'PUBG_',
  'MLBB_',
  'ROBLOX_',
] as const;

// Rule 1: a worker-prefixed name that is shaped like a credential. SSID and HASH are the
// Fragment cookie / page-hash spellings; "_ENC" is a sealed blob; PASS (WDGZONE_PASS), SESSION
// (FRAGMENT_SESSION), AUTH and CREDENTIAL are the other common spellings, and a bare PK / SK
// segment is a private / secret key (HOT_WALLET_PK, TON_WALLET_SK). Only worker prefixes
// reach this rule, so the broad words cannot hit unrelated developer-shell variables.
const SECRET_SHAPED =
  /KEY|SECRET|TOKEN|PASS|SSID|HASH|COOKIE|MNEMONIC|PRIVATE|SEED|SESSION|AUTH|CREDENTIAL|(^|_)(PK|SK)$|_ENC$/;

// Rule 2: wallet material is refused under ANY name or prefix: the mnemonic / seed phrase and
// the Fragment session cookies. Deliberately nothing broader (no bare SEED, COOKIE or
// PRIVATE_KEY): PYTHONHASHSEED, COOKIE_SECRET and JWT_PRIVATE_KEY are not wallet material.
const WALLET_MATERIAL = /MNEMONIC|SEED_?PHRASE|^STEL_|^FRAGMENT_.*COOKIE/;

const WORKER_ONLY_SET: ReadonlySet<string> = new Set(WORKER_ONLY_SECRETS);

/** True when an env variable of this name must never exist in the API process. */
export function isWorkerOnlySecretName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    WORKER_ONLY_SET.has(upper) ||
    WALLET_MATERIAL.test(upper) ||
    (WORKER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix)) && SECRET_SHAPED.test(upper))
  );
}

type Source = Readonly<Record<string, string | undefined>>;

export function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

// Returns the reason a value is unsafe for production, never the value itself.
export function placeholderReason(value: string, minLength: number | null): string | null {
  const v = value.trim();
  if (/^change-me/i.test(v)) return 'is a placeholder (starts with "change-me")';
  if (/^<.*>$/s.test(v)) return 'is a placeholder (wrapped in <...>)';
  if (minLength !== null && v.length < minLength) {
    return `is too short for production (minimum ${minLength} characters)`;
  }
  return null;
}

/** API boot: one problem per set variable that only the worker may hold. Names, not values. */
export function workerSecretProblems(source: Source): string[] {
  return Object.keys(source)
    .filter((name) => !isBlank(source[name]) && isWorkerOnlySecretName(name))
    .map(
      (name) =>
        `${name}: worker-only secret must not be set in the API environment (remove it; only apps/worker may hold it)`,
    );
}

/** Worker boot: one problem per set variable that only the API may hold. Names, not values. */
export function apiSecretProblems(source: Source): string[] {
  return API_ONLY_SECRETS.filter((name) => !isBlank(source[name])).map(
    (name) =>
      `${name}: API-only secret must not be set in the worker environment (remove it; only apps/api may hold it)`,
  );
}

/** Production placeholder / length problems for the given groups. Names, not values. */
export function productionSecretProblems(
  source: Source,
  generated: readonly string[],
  issued: readonly string[],
): string[] {
  const problems: string[] = [];
  const check = (names: readonly string[], minLength: number | null): void => {
    for (const name of names) {
      const value = source[name];
      if (value === undefined || isBlank(value)) continue;
      const reason = placeholderReason(value, minLength);
      if (reason) problems.push(`${name}: ${reason}`);
    }
  };
  check(generated, MIN_GENERATED_SECRET_LENGTH);
  check(issued, null);
  return problems;
}

/**
 * Process entry points only (NOT the env schema, which tests parse directly): `NODE_ENV=test`
 * relaxes behaviour meant for test suites (fake webhook modes, no CSRF-cookie hardening), so a
 * deployed process must never run in it. Jest sets JEST_WORKER_ID in every worker; nothing else
 * does. This guards against an operator mistake, not an attacker: an env that sets
 * JEST_WORKER_ID by hand gets past it. Returns the reason to refuse to start, or null.
 */
export function testModeOutsideJestProblem(source: Source): string | null {
  if (source.NODE_ENV !== 'test' || !isBlank(source.JEST_WORKER_ID)) return null;
  return 'NODE_ENV: "test" is only for test runs; refusing to start a server in it (use development or production)';
}
