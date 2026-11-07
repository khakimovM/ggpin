import { z } from 'zod';

// A Telegram user / bot id: positive, digits only, no leading zero. BigInt like the stored
// BankMessage.senderId, so the comparison is exact.
const botId = z
  .string()
  .regex(/^[1-9]\d{0,19}$/, 'must be the numeric Telegram id of the bank bot (digits only)')
  .transform((v) => BigInt(v))
  .optional();

/**
 * Bank-feed knobs the matcher reads (docs/05 §4, §6).
 *
 * - BANK_FEED_HUMO_BOT_ID / BANK_FEED_UZCARD_BOT_ID: the pinned numeric ids of @HUMOcardbot and
 *   @CardXabarBot. The listener (S7) accepts messages only from them; the matcher checks every
 *   stored PARSED message against them again (defence in depth, a mismatch is never credited).
 *   Required in production: without them every message would go to review.
 * - BANK_FEED_LOCK_TIMEOUT_MS: `lock_timeout` of the matcher's and the card-limit check's
 *   transactions (the same idea as the API's card-lock wait, CardLockTiming.lockWaitMs). A busy
 *   card makes the job fail with 55P03 and retry, never hang.
 */
export const workerBankFeedShape = {
  BANK_FEED_HUMO_BOT_ID: botId,
  BANK_FEED_UZCARD_BOT_ID: botId,
  BANK_FEED_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(3_000),
} as const;

export interface WorkerBankFeedEnv {
  readonly BANK_FEED_HUMO_BOT_ID?: bigint | undefined;
  readonly BANK_FEED_UZCARD_BOT_ID?: bigint | undefined;
}

export function workerBankFeedProblems(env: WorkerBankFeedEnv, production: boolean): string[] {
  if (!production) return [];
  const problems: string[] = [];
  if (env.BANK_FEED_HUMO_BOT_ID === undefined) {
    problems.push('BANK_FEED_HUMO_BOT_ID: is required in production');
  }
  if (env.BANK_FEED_UZCARD_BOT_ID === undefined) {
    problems.push('BANK_FEED_UZCARD_BOT_ID: is required in production');
  }
  return problems;
}
