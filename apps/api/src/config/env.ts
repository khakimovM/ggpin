import { z } from 'zod';
import { isBlank, productionSecretProblems, workerSecretProblems } from './env-security';

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

const httpUrl = z.url({ protocol: /^https?$/ });

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
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BRAND_NAME: z.string().min(1).optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  WEB_URL: httpOrigin,
  ADMIN_URL: httpOrigin,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool('false'),
  // Swagger is off unless explicitly enabled, in every environment including production.
  SWAGGER_ENABLED: bool('false'),

  // ---- Optional now; the named phase makes them required (and checks them at boot). ----
  // Phase 2 (auth): sessions and Mini App tokens.
  JWT_ACCESS_SECRET: z.string().optional(),
  JWT_REFRESH_SECRET: z.string().optional(),
  TG_SESSION_SECRET: z.string().optional(),
  TG_INITDATA_MAX_AGE_SEC: z.coerce.number().int().positive().default(86400),
  // Phase 3 (bot): grammY, webhook in production.
  MINI_APP_URL: httpUrl.optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{5,32}$/, 'must be a Telegram bot username without "@"')
    .optional(),
  TELEGRAM_WEBHOOK_URL: httpUrl.optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
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

  if (clean.NODE_ENV === 'production') {
    problems.push(...productionSecretProblems(clean));
    for (const name of ['WEB_URL', 'ADMIN_URL', 'MINI_APP_URL', 'TELEGRAM_WEBHOOK_URL']) {
      const value = clean[name];
      if (value !== undefined && !value.startsWith('https://')) {
        problems.push(`${name}: must use https in production`);
      }
    }
  }

  if (!parsed.success || problems.length > 0) throw new EnvValidationError(problems);
  return Object.freeze(parsed.data);
}
