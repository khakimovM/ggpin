// When a mock action needs the acting admin's code: one rule table for the confirm route (which
// answers OTP_NOT_REQUIRED otherwise, SA-M1) and the write routes (which answer OTP_REQUIRED).
// The rules follow docs/04 and the API's step-up: money above the threshold, every credit and
// review credit, card retire, a card limit that lowers one, lifting a SECURITY pause.
import type { AdminConfirmationBody } from '@repo/shared';
import { mid } from './data-common';
import { cardsView, paymentsView } from './mock-views';

/** `me.limits.confirmThresholdTiyin` of the mock (fixtures.ts). */
export const MOCK_THRESHOLD_TIYIN = 10_000_000n;

/** The mock's card on a SECURITY pause (the UZCARD one, paused in the fixtures). */
export const SECURITY_PAUSED_CARD = mid('card', 2);

function lowers(cardId: string, receive: string, monthly: string | null | undefined): boolean {
  const card = cardsView().find((one) => one.id === cardId);
  if (card === undefined) return false;
  if (BigInt(receive) < BigInt(card.receiveLimitTiyin)) return true;
  if (monthly === undefined || monthly === null) return false;
  return card.monthlyLimitTiyin === null || BigInt(monthly) < BigInt(card.monthlyLimitTiyin);
}

/** True when the action described by `body` needs a code now. */
export function codeNeeded(body: AdminConfirmationBody): boolean {
  switch (body.action) {
    case 'users.adjustWallet': {
      const amount = BigInt(body.amountTiyin);
      return amount > 0n || -amount > MOCK_THRESHOLD_TIYIN;
    }
    case 'payments.reverse': {
      const payment = paymentsView().find((one) => one.id === body.targetId);
      return payment !== undefined && BigInt(payment.amountTiyin) > MOCK_THRESHOLD_TIYIN;
    }
    case 'cards.resume':
      return body.targetId === SECURITY_PAUSED_CARD && body.confirmSecurityPause;
    case 'cards.limit':
      return lowers(body.targetId, body.receiveLimitTiyin, body.monthlyLimitTiyin);
    default:
      return true;
  }
}
