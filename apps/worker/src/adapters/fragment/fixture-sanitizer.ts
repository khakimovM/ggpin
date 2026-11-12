import { payloadNeedles, redactPayloads } from './payload-scan';
import {
  isPlaceholder,
  isRandomToken,
  kindForKey,
  outsidePlaceholders,
  patternRules,
  placeholder,
  type PatternRule,
} from './sanitizer-rules';
import { exactPatterns, type SecretValue } from './secret-forms';
import { parseTonAddress, type TonAccountId } from './ton-address-forms';

export { placeholder, type SecretKind } from './sanitizer-rules';
export type { SecretValue } from './secret-forms';

// Turns recorded Fragment responses into fixtures (plan S0b): cookies, `stel_*` values, the API
// hash, names (and each of their words), usernames, photo URLs, e-mails, the owner's wallet and
// Telegram id, BOC payloads and long random tokens become `<REDACTED:kind>`; the JSON structure,
// keys, value types and Fragment's own pay address (public, Q7) stay. Running it twice changes
// nothing. Whatever it misses is the job of the independent leak check (leak-check.ts).

export interface SanitizerInput {
  /** Values known to be secret (cookie values, hash, names, ...): every spelling is removed. */
  readonly secrets: readonly SecretValue[];
  /** Fragment's public pay addresses: kept. Every other TON address is redacted. */
  readonly keepAddresses: readonly string[];
}

export interface FixtureSanitizer {
  sanitizeJson(value: unknown): unknown;
  sanitizeText(text: string): string;
}

const NUMERIC_KINDS = new Set(['tg_id', 'phone']);

/** The parsed value of a string that holds a JSON object, array or string, else undefined. */
function nestedJson(text: string): unknown {
  const trimmed = text.trim();
  if (!/^[[{"]/.test(trimmed)) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object'
      ? parsed
      : typeof parsed === 'string'
        ? parsed
        : undefined;
  } catch {
    return undefined;
  }
}

export function createFixtureSanitizer(input: SanitizerInput): FixtureSanitizer {
  const exact = input.secrets
    .flatMap((secret) => exactPatterns(secret))
    .sort((a, b) => b.source.length - a.source.length)
    .map((p) => ({ kind: p.kind, pattern: new RegExp(p.source, p.flags) }));
  // A secret account is never kept, even when it is in the keep list (R-4, N7).
  const secretAccounts = input.secrets
    .filter((s) => s.kind === 'address' || s.kind === 'wallet')
    .map((s) => parseTonAddress(s.value.trim()))
    .filter((id): id is TonAccountId => id !== null);
  const keep = input.keepAddresses.filter((a) => {
    const id = parseTonAddress(a);
    return id !== null && !secretAccounts.some((s) => s.hash.equals(id.hash));
  });
  const keepSet = new Set(keep);
  const patterns: PatternRule[] = patternRules(keep);
  const needles = payloadNeedles(input.secrets);
  const numericSecrets = new Set(
    input.secrets.filter((s) => NUMERIC_KINDS.has(s.kind)).map((s) => s.value.trim()),
  );

  const sanitizeText = (text: string): string => {
    let result = outsidePlaceholders(text, (part) =>
      redactPayloads(part, needles, placeholder('payload')),
    );
    for (const rule of patterns.filter((p) => p.early === true)) {
      result = outsidePlaceholders(result, rule.apply);
    }
    for (const { kind, pattern } of exact) {
      result = outsidePlaceholders(result, (part) => part.replace(pattern, placeholder(kind)));
    }
    for (const rule of patterns.filter((p) => p.early !== true)) {
      result = outsidePlaceholders(result, rule.apply);
    }
    return result;
  };

  const walk = (value: unknown, key: string | null): unknown => {
    const kind = key === null ? null : kindForKey(key);
    if (typeof value === 'string') {
      if (kind !== null && value !== '') return placeholder(kind);
      // JSON inside a string (audit NEST1, NEST2; a JSON-string body): walked as JSON.
      const nested = nestedJson(value);
      if (nested !== undefined) return JSON.stringify(walk(nested, key));
      if (isPlaceholder(value) || keepSet.has(value)) return value;
      // Text rules first, so a BOC is reported as a payload; an untouched random value is a token.
      const cleaned = sanitizeText(value);
      if (cleaned !== value) return cleaned;
      return isRandomToken(value) ? placeholder('token') : value;
    }
    if (typeof value === 'number') {
      if (kind !== null || numericSecrets.has(String(value))) return 0;
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [sanitizeText(k), walk(v, k)]),
      );
    }
    return value;
  };

  return { sanitizeJson: (value) => walk(value, null), sanitizeText };
}
