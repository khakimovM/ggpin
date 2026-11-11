import { z } from 'zod';
import {
  SessionCryptoError,
  decryptSession,
  parseSessionKey,
} from '../bank-feed/client/session-crypto';

// A Telegram user / bot id: positive, digits only, no leading zero. BigInt like the stored
// BankMessage.senderId, so the comparison is exact; at most 2^53 - 1, because mtcute takes the
// peer as a JS number (a larger id would be rounded silently, D-52).
const botId = z
  .string()
  .regex(/^[1-9]\d{0,19}$/, 'must be the numeric Telegram id of the bank bot (digits only)')
  .transform((v) => BigInt(v))
  .refine((v) => v <= BigInt(Number.MAX_SAFE_INTEGER), 'must not exceed 2^53 - 1')
  .optional();

export const BANK_FEED_MODES = ['off', 'fake', 'live'] as const;
export type BankFeedMode = (typeof BANK_FEED_MODES)[number];

/**
 * Bank-feed knobs (docs/05 §4, §6).
 *
 * - BANK_FEED_HUMO_BOT_ID / BANK_FEED_UZCARD_BOT_ID: the pinned numeric ids of @HUMOcardbot and
 *   @CardXabarBot. The listener accepts messages only from them; the matcher checks every stored
 *   PARSED message against them again (defence in depth, a mismatch is never credited).
 *   Required in production and in live mode; they must be two different bots (S9-I2).
 * - BANK_FEED_LOCK_TIMEOUT_MS: `lock_timeout` of the matcher's and the card-limit check's
 *   transactions. A busy card makes the job fail with 55P03 and retry, never hang.
 * - BANK_FEED_MODE: off (default: no client, the re-scan says `unavailable`) | fake (dev/test:
 *   in-memory client, no Telegram; refused in production) | live (MTProto user session).
 * - BANK_FEED_API_ID / BANK_FEED_API_HASH: the working account's my.telegram.org app (E-19).
 * - BANK_FEED_SESSION_ENC / BANK_FEED_ENC_KEY: the session from the login CLI, AES-256-GCM
 *   (session-crypto.ts); opened in memory only. A blob that does not open is a boot error. The key
 *   comes from BANK_FEED_ENC_KEY_FILE (a Docker secret, the only way in production) or, in dev and
 *   test, inline; loadEnv resolves it (secret-file.ts) into BANK_FEED_ENC_KEY (D-52 D3).
 * - BANK_FEED_POLL_SEC: the history poll interval (the main channel; updates only nudge it), 5-60 s.
 */
export const workerBankFeedShape = {
  BANK_FEED_HUMO_BOT_ID: botId,
  BANK_FEED_UZCARD_BOT_ID: botId,
  BANK_FEED_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(3_000),
  BANK_FEED_MODE: z.enum(BANK_FEED_MODES).default('off'),
  BANK_FEED_API_ID: z
    .string()
    .regex(/^[1-9]\d{0,9}$/, 'must be the numeric api_id from my.telegram.org')
    .transform((v) => Number(v))
    .refine((v) => v <= 2_147_483_647, 'must fit a 32-bit api_id')
    .optional(),
  BANK_FEED_API_HASH: z
    .string()
    .regex(/^[0-9a-f]{32}$/i, 'must be the 32 hex characters of the api_hash')
    .optional(),
  BANK_FEED_SESSION_ENC: z.string().optional(),
  BANK_FEED_ENC_KEY: z.string().optional(),
  BANK_FEED_ENC_KEY_FILE: z.string().optional(),
  BANK_FEED_POLL_SEC: z.coerce.number().int().min(5).max(60).default(20),
} as const;

export interface WorkerBankFeedEnv {
  readonly BANK_FEED_HUMO_BOT_ID?: bigint | undefined;
  readonly BANK_FEED_UZCARD_BOT_ID?: bigint | undefined;
  readonly BANK_FEED_MODE: BankFeedMode;
  readonly BANK_FEED_API_ID?: number | undefined;
  readonly BANK_FEED_API_HASH?: string | undefined;
  readonly BANK_FEED_SESSION_ENC?: string | undefined;
  readonly BANK_FEED_ENC_KEY?: string | undefined;
}

const LIVE_REQUIRED = [
  'BANK_FEED_API_ID',
  'BANK_FEED_API_HASH',
  'BANK_FEED_SESSION_ENC',
  'BANK_FEED_ENC_KEY',
  'BANK_FEED_HUMO_BOT_ID',
  'BANK_FEED_UZCARD_BOT_ID',
] as const satisfies readonly (keyof WorkerBankFeedEnv)[];

/** Cross-field rules. Messages name the variables, never a value. */
export function workerBankFeedProblems(env: WorkerBankFeedEnv, production: boolean): string[] {
  const problems: string[] = [];
  if (production && env.BANK_FEED_MODE === 'fake') {
    problems.push('BANK_FEED_MODE: fake is refused in production (use live or off)');
  }
  const required = new Set<string>();
  if (production) {
    required.add('BANK_FEED_HUMO_BOT_ID');
    required.add('BANK_FEED_UZCARD_BOT_ID');
  }
  if (env.BANK_FEED_MODE === 'live') for (const name of LIVE_REQUIRED) required.add(name);
  for (const name of LIVE_REQUIRED) {
    if (!required.has(name) || env[name] !== undefined) continue;
    const why = env.BANK_FEED_MODE === 'live' ? 'with BANK_FEED_MODE=live' : 'in production';
    const label =
      name === 'BANK_FEED_ENC_KEY'
        ? 'BANK_FEED_ENC_KEY_FILE (or BANK_FEED_ENC_KEY outside production)'
        : name;
    problems.push(`${label}: is required ${why}`);
  }
  const humo = env.BANK_FEED_HUMO_BOT_ID;
  if (humo !== undefined && humo === env.BANK_FEED_UZCARD_BOT_ID) {
    // One bot as two sources would let one chat's messages count for both banks (S9-I2).
    problems.push('BANK_FEED_HUMO_BOT_ID and BANK_FEED_UZCARD_BOT_ID: must be two different bots');
  }
  problems.push(...sessionProblems(env));
  return problems;
}

// The blob is opened once here so a wrong key or a damaged blob stops the boot with a readable
// reason; the plaintext is dropped at once (the client opens it again when it starts).
function sessionProblems(env: WorkerBankFeedEnv): string[] {
  const keyText = env.BANK_FEED_ENC_KEY;
  if (keyText === undefined) return [];
  try {
    const key = parseSessionKey(keyText);
    if (env.BANK_FEED_SESSION_ENC !== undefined) decryptSession(env.BANK_FEED_SESSION_ENC, key);
    return [];
  } catch (error) {
    if (error instanceof SessionCryptoError) return [error.message];
    throw error;
  }
}
