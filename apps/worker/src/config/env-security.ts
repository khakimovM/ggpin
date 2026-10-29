// Secret policy for the worker process. Explicit lists (not name heuristics) so a reviewer can
// see exactly what is enforced. Mirror of apps/api/src/config/env-security.ts; the two should
// move to packages/shared once that package may host env helpers.

// The worker is the ONLY process allowed to hold these (CLAUDE.md §5.7). They are optional
// until phases 5-6 (Fragment/TON, suppliers) but, when present, subject to the production
// placeholder rule. Keep in sync with apps/api WORKER_ONLY_SECRETS (the API rejects them).
export const MIN_GENERATED_SECRET_LENGTH = 32;

// Encryption keys / sealed blobs we generate ourselves: long and random in production.
export const PRODUCTION_GENERATED_SECRETS = [
  'TON_MNEMONIC_ENC',
  'WALLET_ENC_KEY',
  'FRAGMENT_SESSION_ENC_KEY',
] as const;

// Credentials issued by a third party; only placeholders are rejected (length is theirs).
export const PRODUCTION_ISSUED_CREDENTIALS = ['TON_API_KEY', 'RESELLER_STARS_API_KEY'] as const;

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
