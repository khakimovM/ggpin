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
  'TELEGRAM_BOT_TOKEN',
  'CLICK_SECRET_KEY',
  'PAYME_KEY',
  'UZUM_SECRET',
  'RAHMAT_SECRET',
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
] as const;

export const WORKER_PRODUCTION_ISSUED_CREDENTIALS = [
  'TON_API_KEY',
  'RESELLER_STARS_API_KEY',
] as const;

/** Every secret env name the system knows; log redaction derives its key names from this. */
export const ALL_SECRET_ENV_NAMES: readonly string[] = [
  ...WORKER_ONLY_SECRETS,
  ...API_ONLY_SECRETS,
];

// ---- Worker-secret detection for the API ---------------------------------------------------
// The exact list above misses a new worker secret that someone forgets to add (e.g.
// SUPPLIER_PUBG_API_KEY). The API therefore also refuses by name shape.

const WORKER_PREFIX = /^(TON_|WALLET_|FRAGMENT_|RESELLER_|SUPPLIER_)/;
const SECRET_SHAPED = /KEY|SECRET|TOKEN|PASSWORD|MNEMONIC|COOKIE|PRIVATE|SEED|_ENC$/;
// Wallet/session material is forbidden in the API whatever it is called or prefixed with.
const ALWAYS_FORBIDDEN = /MNEMONIC|PRIVATE_KEY|SEED|COOKIE/;

const WORKER_ONLY_SET: ReadonlySet<string> = new Set(WORKER_ONLY_SECRETS);

/** True when an env variable of this name must never exist in the API process. */
export function isWorkerOnlySecretName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    WORKER_ONLY_SET.has(upper) ||
    ALWAYS_FORBIDDEN.test(upper) ||
    (WORKER_PREFIX.test(upper) && SECRET_SHAPED.test(upper))
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
