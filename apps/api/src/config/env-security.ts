// Secret policy for the API process. The name lists and the pure helpers live in
// @repo/shared (shared with the worker); this file only binds them to the API's groups.
import {
  API_PRODUCTION_GENERATED_SECRETS,
  API_PRODUCTION_ISSUED_CREDENTIALS,
  isBlank,
  productionSecretProblems as sharedProductionSecretProblems,
} from '@repo/shared';

export { isBlank, workerSecretProblems } from '@repo/shared';

type Source = Readonly<Record<string, string | undefined>>;

export function productionSecretProblems(source: Source): string[] {
  return sharedProductionSecretProblems(
    source,
    API_PRODUCTION_GENERATED_SECRETS,
    API_PRODUCTION_ISSUED_CREDENTIALS,
  );
}

// Key separation: if two of these were equal, a token or code minted for one purpose could be
// forged or verified under another (e.g. a refresh token accepted as a Mini App session).
// Names only in the message, never values.
const MUST_DIFFER = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'TG_SESSION_SECRET', 'OTP_PEPPER'];

export function duplicateSecretProblems(source: Source): string[] {
  const problems: string[] = [];
  const present = MUST_DIFFER.filter((name) => !isBlank(source[name]));
  for (const [i, a] of present.entries()) {
    for (const b of present.slice(i + 1)) {
      if (source[a]?.trim() === source[b]?.trim()) {
        problems.push(`${b}: must differ from ${a} (each signing secret needs its own value)`);
      }
    }
  }
  return problems;
}

// Cross-field rules for the bot. Field formats live in the schema (env.ts); this adds what
// depends on the mode or on NODE_ENV. A bad TELEGRAM_BOT_MODE is reported by the schema.
export function telegramModeProblems(source: Source): string[] {
  const problems: string[] = [];
  const mode = isBlank(source.TELEGRAM_BOT_MODE) ? 'off' : source.TELEGRAM_BOT_MODE;
  if (source.NODE_ENV === 'production' && mode !== 'webhook') {
    problems.push(
      'TELEGRAM_BOT_MODE: must be "webhook" in production (long polling is for development)',
    );
  }
  if (mode === 'webhook') {
    const url = source.TELEGRAM_WEBHOOK_URL;
    if (isBlank(url)) {
      problems.push('TELEGRAM_WEBHOOK_URL: is required when TELEGRAM_BOT_MODE=webhook');
    } else if (!url?.startsWith('https://')) {
      problems.push('TELEGRAM_WEBHOOK_URL: must use https (Telegram only delivers to https)');
    }
    if (isBlank(source.TELEGRAM_WEBHOOK_SECRET)) {
      problems.push('TELEGRAM_WEBHOOK_SECRET: is required when TELEGRAM_BOT_MODE=webhook');
    }
  }
  return problems;
}
