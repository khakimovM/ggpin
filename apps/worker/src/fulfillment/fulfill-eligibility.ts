import type { PrepareResult } from '../adapters/fulfillment-adapter';

// What a fresh attempt does when `prepare` says the recipient cannot be paid (phase 6 S1). Every
// case here is BEFORE the SENDING commit, so nothing has left: the order is FAILED and refunded in
// one transaction (OrderStateRepository.failAndRefund -> refundFailedOrderWith, `ORDER/<orderId>`),
// never HELD and never paid.
//
// RECIPIENT_REFUSED (owner Q2 = A, no migration): the recipient is still the validated one but can
// no longer receive the product (Telegram Premium appeared after the quote, so Fragment refuses
// the gift). The order reason stays RECIPIENT_GONE (the DB CHECK allows no new reason without a
// migration); the event note says why, for the admin timeline. The customer is told "refunded",
// as for any other refund.

export type RecipientRefund = {
  readonly kind: 'REFUND';
  readonly reason: 'RECIPIENT_CHANGED' | 'RECIPIENT_GONE';
  /** The order events' note; null keeps the default ("failed: <reason>"). */
  readonly note: string | null;
};

/** The note of a refund for a recipient who can no longer receive the product (no PII in it). */
export const RECIPIENT_REFUSED_NOTE =
  'failed: RECIPIENT_GONE (the recipient can no longer receive the product, e.g. Telegram ' +
  'Premium appeared after the quote); nothing was sent';

type RecipientProblem = Extract<
  PrepareResult['status'],
  'RECIPIENT_CHANGED' | 'RECIPIENT_GONE' | 'RECIPIENT_REFUSED'
>;

export function recipientRefund(status: RecipientProblem): RecipientRefund {
  switch (status) {
    case 'RECIPIENT_CHANGED':
    case 'RECIPIENT_GONE':
      return { kind: 'REFUND', reason: status, note: null };
    case 'RECIPIENT_REFUSED':
      return { kind: 'REFUND', reason: 'RECIPIENT_GONE', note: RECIPIENT_REFUSED_NOTE };
  }
}
