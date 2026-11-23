import type {
  AdminCard,
  AdminCardLimitBody,
  AdminConfirmationBody,
  AdminOtpAnswer,
} from '@repo/shared';
import { amountOrNull } from '../common/amount-input';
import { CREDIT_RULES } from './review-credit-model';

// card:limit's one body builder (docs/04 «cards/:id/limit»). Whether the change lowers a limit is
// the API's `lowersCardLimit`, repeated here in bigint only to show the code step in time; the
// API decides again under the card lock.

export interface LimitInput {
  cardId: string;
  receiveLimitTiyin: string;
  /** null removes the monthly cap; undefined keeps the current one. */
  monthlyLimitTiyin: string | null | undefined;
}

/** The two fields as typed → the limits to send, or null while one of them is invalid. */
export function limitInput(
  card: Pick<AdminCard, 'id'>,
  typed: { receive: string; monthly: string; removeMonthly: boolean },
): LimitInput | null {
  const receive = amountOrNull(typed.receive, CREDIT_RULES);
  if (receive === null) return null;
  if (typed.removeMonthly) {
    return { cardId: card.id, receiveLimitTiyin: receive, monthlyLimitTiyin: null };
  }
  if (typed.monthly.trim() === '') {
    return { cardId: card.id, receiveLimitTiyin: receive, monthlyLimitTiyin: undefined };
  }
  const monthly = amountOrNull(typed.monthly, CREDIT_RULES);
  return monthly === null
    ? null
    : { cardId: card.id, receiveLimitTiyin: receive, monthlyLimitTiyin: monthly };
}

/** True when the change lowers a limit (then a code is needed): bigint comparisons only. */
export function lowersLimit(
  card: Pick<AdminCard, 'receiveLimitTiyin' | 'monthlyLimitTiyin'>,
  input: Pick<LimitInput, 'receiveLimitTiyin' | 'monthlyLimitTiyin'>,
): boolean {
  if (BigInt(input.receiveLimitTiyin) < BigInt(card.receiveLimitTiyin)) return true;
  const monthly = input.monthlyLimitTiyin;
  if (monthly === undefined || monthly === null) return false;
  return card.monthlyLimitTiyin === null || BigInt(monthly) < BigInt(card.monthlyLimitTiyin);
}

function limits(input: LimitInput) {
  return {
    receiveLimitTiyin: input.receiveLimitTiyin,
    ...(input.monthlyLimitTiyin === undefined
      ? {}
      : { monthlyLimitTiyin: input.monthlyLimitTiyin }),
  };
}

export function limitConfirmation(input: LimitInput): AdminConfirmationBody {
  return { action: 'cards.limit', targetId: input.cardId, ...limits(input) };
}

export function limitBody(
  input: LimitInput,
  extra: { reason: string; otp: AdminOtpAnswer | null },
): AdminCardLimitBody {
  return {
    ...limits(input),
    reason: extra.reason,
    ...(extra.otp === null ? {} : { otp: extra.otp }),
  };
}
