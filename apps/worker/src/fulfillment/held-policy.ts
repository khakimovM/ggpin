import { CORE_HOLD_NOTE_PREFIX, type OrderStatusReason } from '@repo/shared';
import { heldNotices, type TonNotice } from '../ton/ton-notices';

// Who held an order and under which owner-alert id (rules/45: a hold is never silent; plan 6.3).
//
// Two kinds of holds exist, told apart by the HELD OrderEvent's note:
// - ATTEMPT holds: an attempt was failed and the order held in one transaction, by the TON module
//   before signing (limits, balance, payee allowlist: S5 writes the note `ton: ...`) or by the core
//   when the wallet stayed unusable through the last retry (TON_NOT_SENT_*). Alert refId
//   `<orderId>_<attemptId>` (S5 review m7), the same id S5 uses, so either side may re-send it.
// - CORE holds: the core held the order before any attempt existed (price above the ceiling, no
//   adapter, a refused or failing prepare, the attempt cap). Alert refId `<orderId>_<eventId>` of
//   that HELD event: a replay repeats it, a later hold of the same order is heard again.
//
// Both refIds are composite (S6 reads the order with refIdSubject). Grouping the `held` alerts
// (S6 audit M-1 (a), before S12) changes `heldNotices` only, for both kinds at once.
//
// Hold reasons (closed list, OrderStatusReason):
//   PRICE_ABOVE_MAX  core: the provider asks more than the order's stored maxCostMinor
//   NO_ADAPTER       core: no enabled, healthy route in the order's cost currency (the router
//                    filters by currency first, S7 M1), or prepared in another currency
//   LIMIT_PER_ORDER  core: SUPPLIER_MAX_PER_ORDER_MICRO_USDT; TON module: TON_MAX_PER_ORDER_NANO
//   LIMIT_DAILY      TON module: TON_MAX_DAILY_NANO (rolling 24 h)
//   LOW_BALANCE      TON module: balance below amount + fee reserve
//   ADAPTER_ERROR    core: prepare failed on the last retry, prepare REFUSED, a bad instruction
//                    (payee outside FRAGMENT_PAY_ADDRESSES included), no PURCHASE, the attempt
//                    cap, the wallet unusable on the last retry, a refused SENDING row, a job
//                    failed for good before any attempt, a re-check by another adapter refused
//                    because the recipient confirmation is older than RECHECK_MAX_AGE_MS (S7 m3,
//                    an operator decides); TON module (second layer): payee not in
//                    FRAGMENT_PAY_ADDRESSES

// The attempt cap's rule, the core hold's note and the not-sent error prefix are the shared ones
// (packages/shared orders/attempt-limit.ts, phase 5 S9b): the owner CLI counts with the same code.

/** The note of the core's attempt hold after the wallet stayed unusable through the last retry. */
export const NOT_SENT_HOLD_NOTE = 'ton: not sent through the last retry';

export function isCoreHold(note: string | null): boolean {
  return note !== null && note.startsWith(CORE_HOLD_NOTE_PREFIX);
}

/** What the customer and the owner hear about one hold (stable job ids, see above). */
export function holdNotices(
  orderId: string,
  holdId: string,
  reason: OrderStatusReason,
): TonNotice[] {
  return heldNotices(orderId, holdId, reason);
}

/** An order left PROCESSING with an unknown outcome (the TON module's shape for the same event). */
export function reviewNotices(orderId: string): TonNotice[] {
  return [
    { kind: 'ORDER_REVIEW', orderId },
    { kind: 'ALERT', alert: 'needsReview', refId: orderId },
  ];
}

/**
 * CRITICAL money anomaly (plan 28, D-64 (6)): the order has no PURCHASE debit of what it cost, so
 * nothing is paid out and the order is held. refId = the order: stable, a repeat is one alert.
 */
export function noPurchaseNotice(orderId: string): TonNotice {
  return { kind: 'ALERT', alert: 'orderNoPurchase', refId: orderId };
}

export function deliveredNotice(orderId: string): TonNotice {
  return { kind: 'ORDER_DELIVERED', orderId };
}
