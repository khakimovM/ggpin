import { checkDailyTopupLimit, dailyWindowStart, type TopupLimitReason } from '@repo/shared';
import { validationError } from '../../common/admin/admin-input';
import type { AppConfig } from '../../config/config.module';
import { INTEGRITY_NOTES } from './card-pause.repository';
import type { CreditUserState } from './review-checks.repository';
import type { ReviewForAction } from './review.repository';

// Pure parts of review:credit (docs/05 §7, D-46): which money a review may give, what the owner
// must confirm, and the user's state the CLI shows and the AuditLog keeps.

/** Who gets the money: a user without a request, or a request (and so its user). */
export type CreditTarget = { readonly userId: string } | { readonly intentId: string };

/** The amount an OPEN review may still give: only a PARSED CREDIT message is money. */
export function creditableAmount(review: ReviewForAction): bigint {
  if (review.status !== 'OPEN') throw validationError('reviewStatus', review.status);
  const message = review.bankMessage;
  if (
    message.parseStatus !== 'PARSED' ||
    message.direction !== 'CREDIT' ||
    message.amountTiyin === null ||
    message.amountTiyin <= 0n
  ) {
    throw validationError('review', 'NOT_A_PARSED_CREDIT');
  }
  return message.amountTiyin;
}

/** The stored message failed the integrity check (not the pinned bot, or its text changed). */
export function needsBankVerification(review: Pick<ReviewForAction, 'note'>): boolean {
  return review.note !== null && INTEGRITY_NOTES.includes(review.note);
}

/** What the owner's code for this credit is bound to (ids only). */
export function creditOtpTarget(reviewId: string, target: CreditTarget): string {
  return 'userId' in target
    ? `review ${reviewId} for user ${target.userId}`
    : `review ${reviewId} for intent ${target.intentId}`;
}

/**
 * The flags the owner's code also confirms (S8 R2), e.g. `override: blocked, overLimit;
 * bank-verified`: the CLI shows them in the code's message, the service recomputes them from the
 * user's state under the wallet lock and refuses a code issued for anything else.
 */
export function creditOtpFlags(
  user: Pick<UserCheck, 'blocked' | 'overLimit'>,
  given: { readonly override: boolean; readonly bankVerified: boolean },
): string {
  const parts: string[] = [];
  if (given.override) {
    const what = [user.blocked ? 'blocked' : '', user.overLimit ? 'overLimit' : ''].filter(
      (w) => w !== '',
    );
    parts.push(`override: ${what.length === 0 ? 'none' : what.join(', ')}`);
  }
  if (given.bankVerified) parts.push('bank-verified');
  return parts.join('; ');
}

export interface UserCheck {
  readonly blocked: boolean;
  readonly purchaseFrozen: boolean;
  readonly accountAgeSec: number;
  readonly usedBaseTiyin: bigint;
  readonly requestedBaseTiyin: bigint;
  /** The cap that leaves the least room today (the new-account one for a young account). */
  readonly limitTiyin: bigint;
  readonly limitReason: TopupLimitReason;
  readonly overLimit: boolean;
}

type LimitConfig = Pick<
  AppConfig,
  'TOPUP_NEW_ACCOUNT_AGE_SEC' | 'TOPUP_DAILY_MAX_TIYIN' | 'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN'
>;

/** The window the daily caps count (the same rolling 24 hours as the matcher). */
export const creditWindowStart = (now: Date): Date => dailyWindowStart(now);

/**
 * The matcher's checks for a credit (blocked user, the daily cap on BASE amounts with the
 * credited intent left out of "used"), for the owner to see and decide on.
 */
export function userCheck(
  state: CreditUserState,
  requestedBaseTiyin: bigint,
  now: Date,
  config: LimitConfig,
): UserCheck {
  const ageMs = now.getTime() - state.createdAt.getTime();
  const verdict = checkDailyTopupLimit({
    usedBaseTiyin: state.usedBaseTiyin,
    requestedBaseTiyin,
    isNewAccount: ageMs < config.TOPUP_NEW_ACCOUNT_AGE_SEC * 1000,
    dailyMaxTiyin: config.TOPUP_DAILY_MAX_TIYIN,
    newAccountDailyMaxTiyin: config.TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN,
  });
  return {
    blocked: state.isBlocked,
    purchaseFrozen: state.purchaseFrozen,
    accountAgeSec: Math.max(0, Math.floor(ageMs / 1000)),
    usedBaseTiyin: state.usedBaseTiyin,
    requestedBaseTiyin,
    limitTiyin:
      verdict.reason === 'NEW_ACCOUNT_DAILY_LIMIT'
        ? config.TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN
        : config.TOPUP_DAILY_MAX_TIYIN,
    limitReason: verdict.reason,
    overLimit: !verdict.ok,
  };
}

/** Why the credit needs `--confirm-override` (the blocked user first), or null. */
export function overrideNeeded(check: UserCheck): 'USER_BLOCKED' | TopupLimitReason | null {
  if (check.blocked) return 'USER_BLOCKED';
  return check.overLimit ? check.limitReason : null;
}

/** The user's state as the AuditLog keeps it (strings for money). */
export function userCheckAudit(check: UserCheck): Record<string, string | number | boolean> {
  return {
    blocked: check.blocked,
    purchaseFrozen: check.purchaseFrozen,
    accountAgeSec: check.accountAgeSec,
    usedBaseTiyin: check.usedBaseTiyin.toString(),
    requestedBaseTiyin: check.requestedBaseTiyin.toString(),
    limitTiyin: check.limitTiyin.toString(),
    limitReason: check.limitReason,
    overLimit: check.overLimit,
  };
}
