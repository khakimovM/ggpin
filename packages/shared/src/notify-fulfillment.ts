// What the API's fulfillment alert renderer may print for each alert (phase 5 S6). Like
// BANK_FEED_ALERT_PARAMS for the bank feed: every `alerts.fulfillment.<kind>` text in uz.json and
// ru.json takes EXACTLY these placeholders (a test holds the catalogs to this list), so a text can
// never ask for something the renderer does not read. Ids, the order #, codes, amounts and a
// SHORTENED wallet address only: never a cookie, a mnemonic, a key, a hash or a full address.
import type { FulfillmentAlertKind } from './fulfillment/fulfillment-alerts';
import type { OwnerAlertKind } from './notify';

export const FULFILLMENT_ALERT_PARAMS = {
  needsReview: ['number', 'product', 'reason', 'ref'],
  held: ['number', 'product', 'reason', 'ref'],
  heldExpiredRefunded: ['number', 'product', 'amount', 'ref'],
  reviewResolved: ['number', 'status', 'ref'],
  fragmentSessionDead: [],
  fragmentSessionRestored: [],
  fragmentAdapterDown: [],
  tonLowBalance: ['balance', 'address'],
  tonDailyLimit: ['number', 'ref'],
  tonSeqnoUnmatched: ['seqno', 'ref'],
  tonConsumedUnmatched: ['number', 'seqno', 'amount', 'to', 'ref'],
  tonBounced: ['number', 'amount', 'to', 'ref'],
  tonWalletBlocked: ['number', 'seqno', 'amount', 'ref'],
  tonWalletCompromised: ['ref'],
  tonWitnessConflict: ['number', 'seqno', 'ref'],
  queueStuck: ['number', 'minutes', 'ref'],
  workerDown: ['minutes'],
} as const satisfies Readonly<Record<FulfillmentAlertKind, readonly string[]>>;

/**
 * How long the oldest waiting fulfill-order job may wait before the API watchdog raises
 * `queueStuck` (D-34 (12), S6 review M2). The alert text prints this number (`{minutes}`), so the
 * promise in the text and the check cannot drift apart.
 */
export const QUEUE_STUCK_AFTER_MS = 5 * 60_000;

/**
 * The owner alerts that jump the tg-outbox queue (S6 audit M-1 (b)): money may have left the
 * wallet, the wallet may be in someone else's hands, fulfillment has stopped, or incoming money
 * is no longer seen (bank feed: a foreign chat, someone else in the working account, the listener
 * stopped or down). A flood of `held` / `tonDailyLimit` alerts (one per order and partner) must
 * never keep these waiting behind the 1 msg/s per-chat gate. All of them are rare and
 * deduplicated by their refId. The one list; the API's notify consumer reads it. The owner's
 * one-time code is critical too (TgOutboxEnqueuer.enqueueEphemeral).
 */
export const CRITICAL_OWNER_ALERTS: readonly OwnerAlertKind[] = Object.freeze([
  // Bank feed (docs/05): security and incoming-money signals.
  'foreignChat',
  'bankChatAnomaly',
  'listenerStopped',
  'listenerDown',
  // Fulfillment (docs/06).
  'needsReview',
  'tonSeqnoUnmatched',
  'tonConsumedUnmatched',
  'tonBounced',
  'tonWalletBlocked',
  'tonWitnessConflict',
  'tonWalletCompromised',
  'queueStuck',
  'workerDown',
]);

/**
 * BullMQ priorities of tg-outbox jobs (1 is the highest; equal priorities are FIFO). EVERY
 * outbox job carries one: BullMQ runs a job WITHOUT a priority before every prioritized job
 * (BullMQ docs, "Prioritized"), so a critical alert can only go first if nothing is unprioritized.
 */
export const TG_OUTBOX_PRIORITY = { critical: 1, normal: 10 } as const;
export type TgOutboxPriority = keyof typeof TG_OUTBOX_PRIORITY;

/** The outbox priority of an owner alert. */
export function ownerAlertPriority(alert: OwnerAlertKind): TgOutboxPriority {
  return CRITICAL_OWNER_ALERTS.includes(alert) ? 'critical' : 'normal';
}

/** The HELD reasons that have an owner-readable label (`alerts.fulfillment.heldReason.<key>`). */
export const HELD_REASON_LABEL_KEYS = {
  PRICE_ABOVE_MAX: 'priceAboveMax',
  LIMIT_PER_ORDER: 'limitPerOrder',
  LIMIT_DAILY: 'limitDaily',
  LOW_BALANCE: 'lowBalance',
  NO_ADAPTER: 'noAdapter',
  ADAPTER_ERROR: 'adapterError',
} as const;

const WORKER_DOWN_REF = /^\d{1,15}$/;

/** The outage start of a `workerDown` refId (epoch ms, alertRef.workerDown), or null. */
export function parseWorkerDownRef(refId: string): Date | null {
  return WORKER_DOWN_REF.test(refId) ? new Date(Number(refId)) : null;
}

const RAW_ADDRESS = /^(-?\d{1,3}):([0-9a-fA-F]{12,})$/;
const KEEP_HEAD = 4;
const KEEP_TAIL = 4;

/**
 * A wallet address as an alert may print it: the workchain, the first and last four hex digits
 * (`0:abcd…7890`), enough to tell our wallets apart, never the whole address (S6 rule). Anything
 * that is not a raw address is shortened the same way by characters; short input becomes `?`.
 */
export function shortTonAddress(address: string): string {
  const raw = RAW_ADDRESS.exec(address);
  if (raw !== null) {
    const [, workchain = '', hex = ''] = raw;
    return `${workchain}:${hex.slice(0, KEEP_HEAD)}…${hex.slice(-KEEP_TAIL)}`;
  }
  if (address.length < KEEP_HEAD + KEEP_TAIL + 4) return '?';
  return `${address.slice(0, KEEP_HEAD)}…${address.slice(-KEEP_TAIL)}`;
}
