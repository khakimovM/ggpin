import {
  ADMIN_ADJUST_MAX_TIYIN,
  type AdminAdjustPreview,
  type AdminAdjustWalletBody,
  type AdminConfirmationBody,
  type AdminOtpAnswer,
} from '@repo/shared';
import { amountOrNull } from '../common/amount-input';

// The wallet adjustment's one body builder (docs/04 «adjust-wallet», binding): the action body and
// the confirmation body come from the same inputs, so the code is always bound to what is sent.

export type AdjustSign = '+' | '-';

export const ADJUST_RULES = { maxTiyin: ADMIN_ADJUST_MAX_TIYIN } as const;

/** The signed tiyin string of a magnitude typed without a sign, or null while it is invalid. */
export function signedAmount(sign: AdjustSign, magnitude: string): string | null {
  const tiyin = amountOrNull(magnitude, ADJUST_RULES);
  if (tiyin === null) return null;
  return sign === '-' ? `-${tiyin}` : tiyin;
}

export interface AdjustInput {
  userId: string;
  /** Signed, non-zero (from `signedAmount`). */
  amountTiyin: string;
  preview: AdminAdjustPreview;
  /** The owner ticked the recent automatic top-ups / the open orders of the preview. */
  recentConfirmed: boolean;
  openOrdersConfirmed: boolean;
  /** The action's `Idempotency-Key`: the confirmation names it (one code, one money movement). */
  idempotencyKey: string;
  /** The signed amount as re-typed for the code (`confirmAmountTiyin`), null when none is asked. */
  confirmAmountTiyin: string | null;
}

/** The two set ids the owner confirmed, only when the preview has them and they were ticked. */
function confirmedSets(input: AdjustInput) {
  const { confirmOverrideSet, confirmOpenOrdersSet } = input.preview;
  return {
    ...(confirmOverrideSet !== null && input.recentConfirmed ? { confirmOverrideSet } : {}),
    ...(confirmOpenOrdersSet !== null && input.openOrdersConfirmed ? { confirmOpenOrdersSet } : {}),
  };
}

/** A tick given for set `ticked` covers the preview's set only while that id is unchanged. */
export function tickedFor(ticked: string | null, current: string | null | undefined): boolean {
  return ticked !== null && current !== undefined && current !== null && ticked === current;
}

/** Every set the preview shows must be ticked before the adjustment can be sent. */
export function setsConfirmed(
  input: Pick<AdjustInput, 'preview' | 'recentConfirmed' | 'openOrdersConfirmed'>,
): boolean {
  const { confirmOverrideSet, confirmOpenOrdersSet } = input.preview;
  return (
    (confirmOverrideSet === null || input.recentConfirmed) &&
    (confirmOpenOrdersSet === null || input.openOrdersConfirmed)
  );
}

export function adjustConfirmation(input: AdjustInput): AdminConfirmationBody {
  return {
    action: 'users.adjustWallet',
    targetId: input.userId,
    amountTiyin: input.confirmAmountTiyin ?? input.amountTiyin,
    ...confirmedSets(input),
    idempotencyKey: input.idempotencyKey,
  };
}

export function adjustBody(
  input: AdjustInput,
  extra: { reason: string; otp: AdminOtpAnswer | null },
): AdminAdjustWalletBody {
  return {
    amountTiyin: input.amountTiyin,
    reason: extra.reason,
    ...confirmedSets(input),
    ...(extra.otp === null ? {} : { otp: extra.otp }),
    ...(extra.otp === null || input.confirmAmountTiyin === null
      ? {}
      : { confirmAmountTiyin: input.confirmAmountTiyin }),
  };
}
