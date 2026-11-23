import {
  ADMIN_ADJUST_MAX_TIYIN,
  ResourceIdSchema,
  type AdminConfirmationBody,
  type AdminCreditPreviewResponse,
  type AdminOtpAnswer,
  type AdminReviewCreditBody,
  type AdminReviewDetailResponse,
} from '@repo/shared';
import { amountOrNull } from '../common/amount-input';

// review:credit's one body builder (docs/04 «reviews/:id/credit», D-46, D-66): the code is always
// asked, and the confirmation and the action body come from the same inputs.

export type CreditTargetKind = 'intent' | 'user';

/** Re-typed amounts are positive; the cap only keeps the parser honest (the server checks). */
export const CREDIT_RULES = { maxTiyin: ADMIN_ADJUST_MAX_TIYIN } as const;

/**
 * Only an OPEN review of a PARSED CREDIT message with an amount can give money (the API's
 * `creditableAmount`); every other review is closed with the owner CLI (docs/04).
 */
export function isCreditable(review: AdminReviewDetailResponse): boolean {
  const message = review.bankMessage;
  return (
    review.status === 'OPEN' &&
    message.parseStatus === 'PARSED' &&
    message.direction === 'CREDIT' &&
    message.amountTiyin !== null &&
    message.amountTiyin !== '0'
  );
}

/** `{ intentId }` or `{ userId }` once the chosen id is well formed, else null. */
export function creditTarget(
  kind: CreditTargetKind,
  ids: { intentId: string; userId: string },
): { intentId: string } | { userId: string } | null {
  const raw = (kind === 'intent' ? ids.intentId : ids.userId).trim();
  if (!ResourceIdSchema.safeParse(raw).success) return null;
  return kind === 'intent' ? { intentId: raw } : { userId: raw };
}

export interface CreditInput {
  reviewId: string;
  target: { intentId: string } | { userId: string };
  confirmOverride: boolean;
  bankVerified: boolean;
  /** The amount as re-typed by the owner (tiyin string), checked against the real one. */
  confirmAmountTiyin: string;
}

/** The re-typed amount's tiyin string, or null while it is not a valid positive amount. */
export function retypedCredit(raw: string): string | null {
  return amountOrNull(raw, CREDIT_RULES);
}

export function creditConfirmation(input: CreditInput): AdminConfirmationBody {
  return {
    action: 'payments.reviewCredit',
    targetId: input.reviewId,
    amountTiyin: input.confirmAmountTiyin,
    ...input.target,
    confirmOverride: input.confirmOverride,
    bankVerified: input.bankVerified,
  };
}

export function creditBody(
  input: CreditInput,
  extra: { reason: string; otp: AdminOtpAnswer },
): AdminReviewCreditBody {
  return {
    ...input.target,
    reason: extra.reason,
    confirmOverride: input.confirmOverride,
    bankVerified: input.bankVerified,
    otp: extra.otp,
    confirmAmountTiyin: input.confirmAmountTiyin,
  };
}

/** One target as a string: the ticks belong to it (CR-1). */
export function targetKeyOf(
  kind: CreditTargetKind,
  target: ReturnType<typeof creditTarget>,
): string {
  return target === null ? '' : `${kind}:${Object.values(target).join('')}`;
}

/** What a preview asks the owner to tick, or null while there is none (R-5). */
export function previewAsks(
  preview: Pick<AdminCreditPreviewResponse, 'overrideNeeded' | 'needsBankVerification'> | undefined,
): string | null {
  if (preview === undefined) return null;
  return `${preview.overrideNeeded ?? '-'}:${String(preview.needsBankVerification)}`;
}

export interface FlagsSeen {
  target: string;
  content: string | null;
}

/**
 * The record a dialog opens with: after an unknown outcome the sent fields carry `asks`, the
 * preview the refilled ticks were given for (N-3), so a first preview asking for something else
 * clears them; otherwise nothing was seen yet.
 */
export function initialFlagsSeen(
  target: string,
  sent: Readonly<Record<string, string | boolean>> | null,
): FlagsSeen {
  const asks = sent?.asks;
  return { target, content: typeof asks === 'string' && asks !== '' ? asks : null };
}

/**
 * The next "ticks were given for" record, or null when nothing changed. Ticks are cleared when the
 * target changes, or when the preview of the same target asks for something else than the one the
 * owner saw. With no preview seen yet (a fresh dialog) the first one clears nothing; a refill after
 * an unknown outcome starts from the preview the ticks were SENT for (`initialFlagsSeen`, N-3).
 */
export function flagsTransition(
  seen: FlagsSeen,
  target: string,
  content: string | null,
): { seen: FlagsSeen; reset: boolean } | null {
  if (seen.target !== target) return { seen: { target, content }, reset: true };
  if (content === null || content === seen.content) return null;
  return { seen: { target, content }, reset: seen.content !== null };
}
