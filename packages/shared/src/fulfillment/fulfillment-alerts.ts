// Owner alerts raised by order fulfillment (docs/06 "Limitlar va ogohlantirishlar"). They travel
// the same `notify` job as the bank-feed alerts (`OWNER_ALERT`); `OwnerAlertKind` in notify.ts is
// the union of both lists. The API renders the text from the row the `refId` names (the order,
// the transfer...) in Uzbek and sends it to every partner (D-53); the worker only says WHAT
// happened. The text never contains a cookie, a mnemonic or a full wallet address.
import { z } from 'zod';

export const FULFILLMENT_ALERT_KINDS = [
  // An order left PROCESSING with an unknown outcome: money may or may not have gone out.
  'needsReview',
  // An order is HELD (price above the ceiling, a limit, no adapter...): the reason is in the row.
  'held',
  // A HELD order outlived HELD_MAX_AGE_MS and was refunded (Q5).
  'heldExpiredRefunded',
  // An operator or the reconciler resolved a NEEDS_REVIEW order.
  'reviewResolved',
  // Fragment session: first failure of an outage (once per death) and the recovery.
  'fragmentSessionDead',
  'fragmentSessionRestored',
  // Fragment answered with a shape we do not know: the adapter is DOWN until fixed.
  'fragmentAdapterDown',
  // Hot wallet: balance under TON_MIN_BALANCE_ALERT_NANO, a TON limit refused a payment, a seqno
  // moved without a transaction of ours (someone else used the wallet: critical).
  'tonLowBalance',
  'tonDailyLimit',
  'tonSeqnoUnmatched',
  // A transfer is CONSUMED_UNMATCHED and its order is stuck in NEEDS_REVIEW: there is no refund
  // path until a human has found out whether the money left (docs/06 runbook). CRITICAL; the alert
  // is emitted by the reconciler (S9), only the key exists here.
  'tonConsumedUnmatched',
  // A transfer is BOUNCED: the destination aborted our message and the value came back (owner
  // decision A1, D-59). The order is held for review; CRITICAL when the bounce is found late (the
  // transfer was already CONFIRMED). Emitted by the reconciler (S9), only the key exists here.
  'tonBounced',
  // An owner resolved a CONSUMED_UNMATCHED transfer as SENT_ELSEWHERE: value left the wallet to an
  // address that is not ours, so the wallet is compromised (owner decision A3). CRITICAL security
  // incident; emitted by the owner CLI (S10) right after the resolution commits.
  'tonWalletCompromised',
  // fulfill-order has waited more than 5 minutes; the worker heartbeat is gone (API watchdog).
  'queueStuck',
  'workerDown',
] as const;

export const FulfillmentAlertKindSchema = z.enum(FULFILLMENT_ALERT_KINDS);
export type FulfillmentAlertKind = z.infer<typeof FulfillmentAlertKindSchema>;
