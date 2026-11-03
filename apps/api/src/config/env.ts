import { testModeOutsideJestProblem } from '@repo/shared';
import { z } from 'zod';
import {
  duplicateSecretProblems,
  isBlank,
  placeholderSecretProblems,
  productionSecretProblems,
  telegramModeProblems,
  workerSecretProblems,
} from './env-security';
import { parseTrustedProxies } from './trust-proxy';

// Strict booleans: "yes", "1", "TRUE" are errors, not silently false.
const bool = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

// Money and limits are BigInt minor units parsed from digit strings; Number would lose
// precision above 2^53 (CLAUDE.md §5.1).
const bigintString = (fallback: string) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer written with digits only')
    .default(fallback)
    .transform((v) => BigInt(v));

// IPs/CIDRs of the reverse proxies allowed to set X-Forwarded-For; empty = trust none.
// See trust-proxy.ts for why this is an allowlist and not a hop count.
const trustedProxies = z
  .string()
  .default('')
  .transform((value, ctx): readonly string[] => {
    const parsed = parseTrustedProxies(value);
    if (parsed.ok) return parsed.entries;
    ctx.addIssue({ code: 'custom', message: parsed.problem });
    return z.NEVER;
  });

const httpUrl = z.url({ protocol: /^https?$/ });

const BOT_TOKEN_FORMAT = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
// Telegram's setWebhook secret_token allows exactly these characters, 1-256 long; we demand 32+.
const WEBHOOK_SECRET_FORMAT = /^[A-Za-z0-9_-]{32,256}$/;

// Origins feed the CORS allowlist, so "https://x.uz/" and "https://x.uz" normalise to one form.
const httpOrigin = httpUrl.transform((v) => new URL(v).origin);

const telegramIdList = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  .pipe(
    z.array(z.string().regex(/^\d+$/, 'must be a comma-separated list of numeric Telegram ids')),
  )
  .transform((ids): readonly bigint[] => ids.map((id) => BigInt(id)));

const EnvSchema = z.object({
  // No default: a forgotten NODE_ENV must not silently become "development" (insecure cookies,
  // relaxed checks). apps/api/.env.example sets it; Jest sets "test".
  NODE_ENV: z.enum(['development', 'test', 'production']),
  BRAND_NAME: z.string().min(1).optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  WEB_URL: httpOrigin,
  ADMIN_URL: httpOrigin,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: trustedProxies,
  // Swagger is off unless explicitly enabled; NODE_ENV=production refuses "true" (checked below).
  SWAGGER_ENABLED: bool('false'),

  // ---- Auth and bot (phase 2): required, the API refuses to boot without them. ----
  // Strength in production and pairwise difference are checked in loadEnv (env-security.ts),
  // where the messages can name variables without echoing values.
  JWT_ACCESS_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),
  TG_SESSION_SECRET: z.string(),
  // Peppers the HMAC of one-time login codes: a 6-digit code is brute-forceable offline
  // without a server-side secret.
  OTP_PEPPER: z.string(),
  // Capped at 24 h (60-security.md): a longer window would let a leaked initData log in for days.
  TG_INITDATA_MAX_AGE_SEC: z.coerce.number().int().positive().max(86400).default(86400),
  // Always required, even with TELEGRAM_BOT_MODE=off: Mini App initData is verified with an
  // HMAC keyed by the bot token.
  TELEGRAM_BOT_TOKEN: z
    .string()
    .regex(BOT_TOKEN_FORMAT, 'must look like "<bot id>:<secret>" as issued by BotFather'),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{5,32}$/, 'must be a Telegram bot username without "@" (5-32 chars)')
    .regex(/bot$/i, 'must end in "bot" (Telegram rule for bot usernames)'),
  // off: updates are not processed (API-only dev, tests); polling: long polling for dev;
  // webhook: Telegram pushes updates (mandatory in production, see telegramModeProblems).
  TELEGRAM_BOT_MODE: z.enum(['off', 'polling', 'webhook']).default('off'),
  TELEGRAM_WEBHOOK_URL: httpUrl.optional(),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(WEBHOOK_SECRET_FORMAT, 'must be 32-256 chars of A-Z a-z 0-9 _ - (Telegram secret_token)')
    .optional(),
  MINI_APP_URL: httpUrl.optional(),
  // Optional "News" button in the bot; hidden when unset.
  TELEGRAM_NEWS_CHANNEL_URL: z.url({ protocol: /^https$/, hostname: /^t\.me$/ }).optional(),

  // ---- Optional now; the named phase makes them required (and checks them at boot). ----
  // Chat that receives operational alerts (low TON balance, NEEDS_REVIEW orders).
  OWNER_ALERT_CHAT_ID: z
    .string()
    .regex(/^-?\d+$/, 'must be a numeric chat id')
    .optional(),
  // Phase 9 (admin): allowlist and money-action thresholds.
  ADMIN_TELEGRAM_IDS: telegramIdList,
  ADMIN_CONFIRM_THRESHOLD_TIYIN: bigintString('100000000'),
  ADMIN_OPERATOR_REFUND_MAX_TIYIN: bigintString('50000000'),
  // Phase 4 (payments): provider credentials and top-up bounds.
  TOPUP_MIN_TIYIN: bigintString('500000'),
  TOPUP_MAX_TIYIN: bigintString('1000000000'),
  CLICK_SERVICE_ID: z.string().optional(),
  CLICK_MERCHANT_ID: z.string().optional(),
  CLICK_SECRET_KEY: z.string().optional(),
  PAYME_MERCHANT_ID: z.string().optional(),
  PAYME_KEY: z.string().optional(),
  PAYME_TEST_MODE: bool('true'),
  UZUM_MERCHANT_ID: z.string().optional(),
  UZUM_SECRET: z.string().optional(),
  RAHMAT_MERCHANT_ID: z.string().optional(),
  RAHMAT_SECRET: z.string().optional(),
});

export type Env = Readonly<z.infer<typeof EnvSchema>>;

// Carries every problem at once so an operator fixes the env in one pass. Messages name the
// variable and the reason, never the value (values may be secrets).
export class EnvValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Invalid environment configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\nSee apps/api/.env.example for the expected variables.',
    );
    this.name = 'EnvValidationError';
  }
}

// An empty `FOO=` line in a .env file means "unset"; otherwise optional vars would fail
// URL/enum checks and `.default()` would never apply.
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(source).filter(([, v]) => !isBlank(v)));
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const clean = withoutBlanks(source);
  const problems: string[] = [];

  const parsed = EnvSchema.safeParse(clean);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = issue.path.map(String).join('.');
      // Zod messages never echo the input, but we also avoid relying on that for "missing".
      const reason =
        issue.path.length === 1 && clean[name] === undefined
          ? 'is required but not set'
          : issue.message;
      problems.push(`${name || '(env)'}: ${reason}`);
    }
  }

  problems.push(...workerSecretProblems(clean));
  problems.push(...duplicateSecretProblems(clean));
  problems.push(...telegramModeProblems(clean));
  let productionReported: readonly string[] = [];

  if (clean.NODE_ENV === 'production') {
    productionReported = productionSecretProblems(clean);
    problems.push(...productionReported);
    // The parsed list, not the raw string: "," or " , " is non-blank text but trusts nobody.
    // (A malformed list is already reported by the schema.)
    const proxies = parseTrustedProxies(clean.TRUST_PROXY ?? '');
    if (proxies.ok && proxies.entries.length === 0) {
      problems.push(
        'TRUST_PROXY: is required in production (without it every client shares the proxy address and rate limits collapse into one bucket)',
      );
    }
    if (clean.SWAGGER_ENABLED === 'true') {
      problems.push(
        'SWAGGER_ENABLED: must not be "true" in production (the API docs would be public)',
      );
    }
    for (const name of ['WEB_URL', 'ADMIN_URL', 'MINI_APP_URL']) {
      const value = clean[name];
      if (value !== undefined && !value.startsWith('https://')) {
        problems.push(`${name}: must use https in production`);
      }
    }
    // The Mini App button and bot links cannot work without it; dev may leave it empty.
    if (clean.MINI_APP_URL === undefined) problems.push('MINI_APP_URL: is required in production');
  }

  // The production check above already names a placeholder; do not report it twice.
  const named = new Set(productionReported.map((p) => p.split(':')[0]));
  problems.push(...placeholderSecretProblems(clean).filter((p) => !named.has(p.split(':')[0])));

  if (!parsed.success || problems.length > 0) throw new EnvValidationError(problems);
  return Object.freeze(parsed.data);
}

/**
 * The loader for the real process entry point (main.ts). On top of loadEnv it refuses
 * NODE_ENV=test unless running under Jest: that mode relaxes checks meant for test suites, so a
 * deployed process must not be able to opt into it. Kept out of loadEnv itself because tests
 * parse the schema directly with NODE_ENV=test.
 */
export function loadProcessEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const problem = testModeOutsideJestProblem(source);
  if (problem !== null) throw new EnvValidationError([problem]);
  return loadEnv(source);
}
