import type { QuoteResponse } from '@repo/shared';
import { errorKey, type ApiErrorMessageKey } from '../../lib/api/errors';
import type { QuoteView } from '../product/use-quote';
import type { ConfirmState } from './ConfirmSheet';
import type { PayOutcome } from './pay-outcome';

export type MessageKey = ApiErrorMessageKey | 'store.product.quote.changed' | 'store.checkout.busy';

export interface ConfirmInput {
  /** An unresolved purchase exists and is not the first send that is running right now. */
  uncertain: boolean;
  paying: boolean;
  /** The signed-in user is not known yet: nothing may be paid. */
  noUser: boolean;
  outcome: PayOutcome | null;
  /** The quote the server called dead (or that ran out): the visitor must renew the price. */
  staleId: string | null;
  live: QuoteResponse | null;
  lapsed: boolean;
  viewStatus: QuoteView['status'];
}

/** Which screen the confirmation shows, and the key of the message it carries, if any. */
export function deriveConfirmState(input: ConfirmInput): {
  state: ConfirmState;
  messageKey?: MessageKey;
} {
  const { outcome, live, staleId } = input;
  const failed: MessageKey | undefined =
    outcome?.kind === 'failed'
      ? errorKey(outcome.code)
      : outcome?.kind === 'busy'
        ? 'store.checkout.busy'
        : undefined;
  // A refusal of the CHECK (a 400, a 429...) is shown inside the "result unknown" panel.
  if (input.uncertain) return { state: 'uncertain', messageKey: failed };
  if (input.paying) return { state: 'paying' };
  if (input.noUser) return { state: 'failed', messageKey: 'common.error.network' };
  if (failed !== undefined) return { state: 'failed', messageKey: failed };
  if (staleId !== null && live !== null && live.quoteId !== staleId) return { state: 'renewed' };
  if (input.viewStatus === 'pending') return { state: 'refreshing' };
  if (staleId !== null || input.lapsed) return { state: 'expired' };
  if (live !== null) return { state: 'ready' };
  const key: MessageKey =
    input.viewStatus === 'unavailable'
      ? 'errors.PRICE_UNAVAILABLE'
      : input.viewStatus === 'rateLimited'
        ? 'errors.RATE_LIMITED'
        : input.viewStatus === 'productChanged'
          ? 'store.product.quote.changed'
          : 'common.error.network';
  return { state: 'failed', messageKey: key };
}
