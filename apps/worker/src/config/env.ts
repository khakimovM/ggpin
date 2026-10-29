import { z } from 'zod';
import { isBlank, productionSecretProblems } from './env-security';

// Strict booleans: "yes", "1", "TRUE" are errors, not silently false.
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

// Money limits are BigInt minor units parsed from digit strings; Number would lose precision
// above 2^53 (CLAUDE.md §5.1).
const bigintString = (fallback: string) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer written with digits only')
    .default(fallback)
    .transform((v) => BigInt(v));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BRAND_NAME: z.string().min(1).optional(),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{5,32}$/, 'must be a Telegram bot username without "@"')
    .optional(),
  OWNER_ALERT_CHAT_ID: z
    .string()
    .regex(/^-?\d+$/, 'must be a numeric chat id')
    .optional(),

  // Real money moves only when this is false. Defaults to true outside production (see
  // loadEnv); in production it must be set explicitly.
  FULFILLMENT_DRY_RUN: bool,
  TON_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  // Hard limits from .claude/rules/45-fulfillment.md; a breach holds the order, never silent.
  TON_MAX_PER_ORDER_NANO: bigintString('50000000000'),
  TON_MAX_DAILY_NANO: bigintString('500000000000'),
  TON_MIN_BALANCE_ALERT_NANO: bigintString('100000000000'),
  SUPPLIER_MAX_PER_ORDER_MICRO_USDT: bigintString('200000000'),
  PRICE_TOLERANCE_BPS: z.coerce.number().int().min(0).max(10_000).default(300),

  // ---- Optional until phases 5-6 (Fragment/TON, suppliers); production placeholder rule applies
  // as soon as they are set. ----
  TON_API_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  TON_API_KEY: z.string().optional(),
  TON_MNEMONIC_ENC: z.string().optional(),
  WALLET_ENC_KEY: z.string().optional(),
  FRAGMENT_SESSION_ENC_KEY: z.string().optional(),
  RESELLER_STARS_API_URL: z.url({ protocol: /^https?$/ }).optional(),
  RESELLER_STARS_API_KEY: z.string().optional(),
});

export type Env = Readonly<z.infer<typeof EnvSchema>>;

// Carries every problem at once so an operator fixes the env in one pass. Messages name the
// variable and the reason, never the value (values may be secrets).
export class EnvValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Invalid environment configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\nSee apps/worker/.env.example for the expected variables.',
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
  const production = clean.NODE_ENV === 'production';
  // Safe-by-default: dry-run unless the operator says otherwise, and in production the
  // operator must say so explicitly (no silent default either way).
  const withDefaults = production ? clean : { FULFILLMENT_DRY_RUN: 'true', ...clean };
  const problems: string[] = [];

  const parsed = EnvSchema.safeParse(withDefaults);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = issue.path.map(String).join('.');
      // Zod messages never echo the input, but we also avoid relying on that for "missing".
      const reason =
        issue.path.length === 1 && withDefaults[name] === undefined
          ? 'is required but not set'
          : issue.message;
      problems.push(`${name || '(env)'}: ${reason}`);
    }
  }

  if (production) problems.push(...productionSecretProblems(clean));

  if (!parsed.success || problems.length > 0) throw new EnvValidationError(problems);
  return Object.freeze(parsed.data);
}
