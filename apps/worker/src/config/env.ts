import { testModeOutsideJestProblem } from '@repo/shared';
import { z } from 'zod';
import { workerBankFeedProblems, workerBankFeedShape } from './bank-feed-env';
import { bankFeedKeySource, forgetBankFeedKey, type SecretFileReader } from './secret-file';
import { apiSecretProblems, isBlank, productionSecretProblems } from './env-security';
import { simulatedPayeeProblems } from './simulated-payee';
import { forgetWalletSecrets, walletKeySource, workerTonProblems, workerTonShape } from './ton-env';
import { TonApiKey } from './ton-api-key';
import { workerTopupProblems, workerTopupShape } from './topup-env';
import { WalletSecretHandle } from './wallet-secret';

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
  // No default: a forgotten NODE_ENV must not silently become "development".
  NODE_ENV: z.enum(['development', 'test', 'production']),
  BRAND_NAME: z.string().min(1).optional(),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{5,32}$/, 'must be a Telegram bot username without "@"')
    .optional(),

  // Real money moves only when this is false. Defaults to true outside production (see
  // loadEnv); in production it must be set explicitly.
  FULFILLMENT_DRY_RUN: bool,
  TON_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  // Hard limits from .claude/rules/45-fulfillment.md; a breach holds the order, never silent. The
  // TON defaults are for dry runs: with DRY_RUN=false both must be set explicitly (audit L5).
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

  // Phase 5: the hot wallet, its key file and the payout timings (ton-env.ts).
  ...workerTonShape,
  // Phase 4 (P2P top-ups): matcher knobs, equal to the API's (topup-env.ts).
  ...workerTopupShape,
  // Phase 4: pinned bank-bot ids and the matcher's lock wait (bank-feed-env.ts).
  ...workerBankFeedShape,
});

type ParsedEnv = z.infer<typeof EnvSchema>;

/**
 * The frozen worker config. The encrypted mnemonic and its key are not in it as strings: the
 * wallet factory takes them once from TON_WALLET_SECRET (audit L2; undefined in a dry run). The
 * TON API key is a redacting holder only the toncenter transport reads (review m5, audit I-3).
 */
export type Env = Readonly<
  Omit<ParsedEnv, 'TON_MNEMONIC_ENC' | 'WALLET_ENC_KEY' | 'TON_API_KEY'> & {
    readonly TON_WALLET_SECRET?: WalletSecretHandle | undefined;
    readonly TON_API_KEY?: TonApiKey | undefined;
  }
>;

function walletSecretOf(blob: string | undefined, key: string | undefined) {
  return blob === undefined || key === undefined
    ? undefined
    : new WalletSecretHandle({ mnemonicBlob: blob, keyText: key });
}

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

export function loadEnv(
  source: NodeJS.ProcessEnv = process.env,
  readSecret?: SecretFileReader,
): Env {
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

  // The worker must not see the API's payment/session/bot secrets (the mirror of the API's
  // worker-secret check): refused in every environment, not only production.
  problems.push(...apiSecretProblems(clean));
  if (production) problems.push(...productionSecretProblems(clean));
  // D-52 D3: the session key comes from its Docker-secret file (or inline outside production).
  const key = bankFeedKeySource(clean, production, readSecret);
  problems.push(...key.problems);
  // Plan §8: in dry run nothing can be sent, so no wallet secret is read or kept (the mnemonic,
  // its key and the TON API key stay out of the config even when set).
  const dryRun = withDefaults.FULFILLMENT_DRY_RUN !== 'false';
  const walletKey = walletKeySource(clean, production, dryRun, readSecret);
  problems.push(...walletKey.problems);
  const data = parsed.success
    ? {
        ...parsed.data,
        BANK_FEED_ENC_KEY: key.key,
        WALLET_ENC_KEY: walletKey.key,
        TON_MNEMONIC_ENC: dryRun ? undefined : parsed.data.TON_MNEMONIC_ENC,
        TON_API_KEY: dryRun ? undefined : parsed.data.TON_API_KEY,
      }
    : null;
  if (data !== null) {
    problems.push(...workerTopupProblems(data));
    problems.push(...workerBankFeedProblems(data, production));
    problems.push(...workerTonProblems(data, clean));
    problems.push(...simulatedPayeeProblems(data, production));
  }

  if (data === null || problems.length > 0) throw new EnvValidationError(problems);
  const {
    TON_MNEMONIC_ENC: blob,
    WALLET_ENC_KEY: walletKeyText,
    TON_API_KEY: apiKey,
    ...config
  } = data;
  return Object.freeze({
    ...config,
    TON_WALLET_SECRET: walletSecretOf(blob, walletKeyText),
    TON_API_KEY: apiKey === undefined ? undefined : new TonApiKey(apiKey),
  });
}

/**
 * The loader for the real process entry point (main.ts). On top of loadEnv it refuses
 * NODE_ENV=test unless running under Jest: that mode relaxes checks meant for test suites, so a
 * deployed process must not be able to opt into it. Kept out of loadEnv itself because tests
 * parse the schema directly with NODE_ENV=test.
 */
export function loadProcessEnv(source: NodeJS.ProcessEnv = process.env): Env {
  try {
    const problem = testModeOutsideJestProblem(source);
    if (problem !== null) throw new EnvValidationError([problem]);
    return loadEnv(source);
  } finally {
    // Read once (also when the config is refused); from here on only the frozen config holds
    // the keys (D-52 D3).
    forgetBankFeedKey(source);
    forgetWalletSecrets(source);
  }
}
