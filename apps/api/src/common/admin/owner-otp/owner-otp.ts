import { createHash } from 'node:crypto';
import { validationError } from '../admin-input';

// The owner's one-time code for money actions above ADMIN_CONFIRM_THRESHOLD_TIYIN (D-46). The
// owner CLI asks for it, the bot sends it to the primary (first) OWNER_ALERT_CHAT_ID only, never
// to the other partners (D-53), the money service checks it BEFORE its transaction and writes
// `after.otpVerified` in the AuditLog. Phase 2 OTP pattern: HMAC(OTP_PEPPER) hash only,
// constant-time compare, attempts counter; the code itself is never stored, logged or printed.

export const OWNER_OTP_ACTIONS = ['review:credit', 'wallet:adjust', 'payment:reverse'] as const;
export type OwnerOtpAction = (typeof OWNER_OTP_ACTIONS)[number];

/** What a code confirms: exactly this action, on this target, for this amount. */
export interface OwnerOtpScope {
  readonly action: OwnerOtpAction;
  /** The re-typed amount (signed for wallet:adjust); the service compares it with the real one. */
  readonly amountTiyin: bigint;
  /** Ids only (review + user/intent, user + key, payment): never a card number or a balance. */
  readonly target: string;
  /**
   * What the owner also confirms besides the amount (review:credit: `override: blocked, overLimit`,
   * `bank-verified`; S8 R2). Empty when nothing; the service recomputes it under its locks.
   */
  readonly flags?: string;
}

/** The CLI's answer: the challenge it holds in memory and the code the owner typed. */
export interface OtpAnswer {
  readonly challengeId: string;
  readonly code: string;
}

export const CHALLENGE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** One line naming the action, the amount, the target and the flags; part of the HMAC input. */
export function otpBinding(scope: OwnerOtpScope): string {
  return `${scope.action}|${scope.amountTiyin.toString()}|${scope.target}|${scope.flags ?? ''}`;
}

/** The HMAC nonce: a hash made for one challenge AND one binding is useless for any other. */
export function otpNonce(challengeId: string, binding: string): string {
  return `${challengeId}|${binding}`;
}

// Redis and the outbox see a digest of the challenge id, never the id the CLI holds.
function handle(challengeId: string): string {
  return createHash('sha256').update(challengeId).digest('hex').slice(0, 32);
}

export const ownerOtpKey = (challengeId: string): string => `owner-otp:${handle(challengeId)}`;
/** The tg-outbox job id of the code's message (no ':' — BullMQ refuses it). */
export const ownerOtpJobId = (challengeId: string): string => `owner-otp-${handle(challengeId)}`;

const magnitude = (tiyin: bigint): bigint => (tiyin < 0n ? -tiyin : tiyin);

/**
 * Above the threshold BOTH are needed: the re-typed amount equal to the real one, and a verified
 * owner code (bound to that re-typed amount). At or below it neither is needed.
 */
export function requireOwnerConfirmation(
  amountTiyin: bigint,
  confirmAmountTiyin: bigint | undefined,
  otpVerified: boolean,
  thresholdTiyin: bigint,
): void {
  if (magnitude(amountTiyin) <= thresholdTiyin) return;
  if (confirmAmountTiyin !== amountTiyin) throw validationError('confirmAmountTiyin');
  if (!otpVerified) throw validationError('otp', 'OTP_REQUIRED');
}
