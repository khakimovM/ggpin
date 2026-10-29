// Secret policy for the API process. Kept as explicit lists (not name heuristics) so a reviewer
// can see exactly what is enforced, and so adding a variable is a deliberate edit.

// Secrets that only apps/worker may hold (CLAUDE.md §5.7, docs/10-SECURITY.md). If the API
// process can see one, a compromised API could move money out of the hot wallet, so boot is
// refused instead of merely ignoring the variable. Derived from apps/worker/.env.example:
// only credentials are listed; harmless config (TON_NETWORK, TON_API_ENDPOINT, *_NANO limits,
// RESELLER_STARS_API_URL, PRICE_TOLERANCE_BPS) is intentionally absent.
export const WORKER_ONLY_SECRETS = [
  'TON_MNEMONIC_ENC',
  'WALLET_ENC_KEY',
  'FRAGMENT_SESSION_ENC_KEY',
  'TON_API_KEY',
  'RESELLER_STARS_API_KEY',
] as const;

export const MIN_GENERATED_SECRET_LENGTH = 32;

// Secrets we generate ourselves: must be long and random in production.
export const PRODUCTION_GENERATED_SECRETS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'TG_SESSION_SECRET',
  'TELEGRAM_WEBHOOK_SECRET',
] as const;

// Credentials issued by a third party. Their length is not ours to dictate (a valid Click key
// may be shorter than 32 chars), so only placeholders are rejected for these.
export const PRODUCTION_ISSUED_CREDENTIALS = [
  'TELEGRAM_BOT_TOKEN',
  'CLICK_SECRET_KEY',
  'PAYME_KEY',
  'UZUM_SECRET',
  'RAHMAT_SECRET',
] as const;

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

export function workerSecretProblems(source: Source): string[] {
  return WORKER_ONLY_SECRETS.filter((name) => !isBlank(source[name])).map(
    (name) =>
      `${name}: worker-only secret must not be set in the API environment (remove it; only apps/worker may hold it)`,
  );
}

export function productionSecretProblems(source: Source): string[] {
  const problems: string[] = [];
  const check = (names: readonly string[], minLength: number | null): void => {
    for (const name of names) {
      const value = source[name];
      if (value === undefined || isBlank(value)) continue;
      const reason = placeholderReason(value, minLength);
      if (reason) problems.push(`${name}: ${reason}`);
    }
  };
  check(PRODUCTION_GENERATED_SECRETS, MIN_GENERATED_SECRET_LENGTH);
  check(PRODUCTION_ISSUED_CREDENTIALS, null);
  return problems;
}
