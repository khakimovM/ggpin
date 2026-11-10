// Job contract for the `notify` queue (QUEUES.NOTIFY): the worker says WHAT happened, the API
// decides how it reads. The payload carries ids only; the API loads the amount and the user's
// language from the database, renders the text, escapes it and puts it on `tg-outbox`.
// That keeps user-facing text and the bot token out of the worker (CLAUDE.md invariant 7)
// and keeps money amounts out of the notify jobs, which stay NOTIFY_DEDUPE_SEC (30 days) for
// deduplication. The rendered text (with the amount and balance) exists only in the tg-outbox
// job, which is kept one day.
import { z } from 'zod';
import { BankFeedAlertKindSchema, type BankFeedSource } from './payments/bank-feed';
import { tgOutboxJobId } from './tg-outbox';

export const NOTIFY_KINDS = ['TOPUP_CREDITED', 'TOPUP_LATE_CREDITED', 'OWNER_ALERT'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

// Ids end up in BullMQ job ids, which cannot take ':' or '-' segments (see tgOutboxJobId), so the
// schema rejects what the id builder would reject. Prisma cuid ids always fit.
const IdSegmentSchema = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);

const topupNotifySchema = z.strictObject({
  kind: z.enum(['TOPUP_CREDITED', 'TOPUP_LATE_CREDITED']),
  // No userId: the API reads it from the Payment row, so a job can never address another user.
  /** The Payment that credited the wallet. */
  refId: IdSegmentSchema,
});

const ownerAlertSchema = z.strictObject({
  kind: z.literal('OWNER_ALERT'),
  alert: BankFeedAlertKindSchema,
  /** The row the alert is about (review, card, message...). Part of the job id. */
  refId: IdSegmentSchema,
});

export const notifyJobSchema = z.discriminatedUnion('kind', [topupNotifySchema, ownerAlertSchema]);
export type NotifyJob = z.infer<typeof notifyJobSchema>;

/**
 * `refId` of the alerts whose subject is not a single row (docs/05 "Ogohlantirishlar jadvali"):
 * `walletFrozen` is one per ledger write, `cardSilent` one per silent period (the last CREDIT
 * time identifies the period, so the job id repeats until a new CREDIT ends it).
 */
export const alertRef = {
  walletFrozen: (userId: string, ledgerEntryId: string): string => `${userId}_${ledgerEntryId}`,
  cardSilent: (cardId: string, lastCreditAt: Date): string =>
    `${cardId}_${Math.floor(lastCreditAt.getTime() / 1000)}`,
  // One per source per hour: a misbehaving client cannot flood the owner (B2).
  foreignChat: (source: BankFeedSource, at: Date): string =>
    `${source}_${String(Math.floor(at.getTime() / 3_600_000))}`,
  // D-52: one per outage per hour; the outage start (the last healthy round, epoch ms) is in the
  // ref, so the API renders the minutes without a heartbeat (a stopped listener clears it).
  listenerDown: (downSince: Date, at: Date): string =>
    `${String(downSince.getTime())}_${String(Math.floor(at.getTime() / 3_600_000))}`,
  listenerStopped: (reason: ListenerStopReason, at: Date): string =>
    `${reason}_${String(Math.floor(at.getTime() / 3_600_000))}`,
  // One per source and reason an hour, like foreignChat (D-52 r2, review M-B): a flood of messages
  // in a bot chat is one alert, not one per message (the Telegram id stays in the log and the row).
  bankChatAnomaly: (source: BankFeedSource, reason: BankChatAnomalyReason, at: Date): string =>
    `${source}_${reason}_${String(Math.floor(at.getTime() / 3_600_000))}`,
  // The listener bound a working account for the first time (D-52 r2, review L-B): the hour.
  accountBound: (at: Date): string => String(Math.floor(at.getTime() / 3_600_000)),
} as const;

/** Why the bank-feed listener stopped for good (alert `listenerStopped`, D-52). */
export const LISTENER_STOP_REASONS = [
  'REVOKED',
  'BANNED',
  'DUPLICATED',
  'BOT_MISMATCH',
  'ACCOUNT_MISMATCH',
  // No bound account but bank history exists (D-52 r2, review L-B): the BankFeedAccount row was
  // deleted; binding now could tie the old cursor to another account (runbook item 3).
  'ACCOUNT_UNBOUND',
] as const;
export type ListenerStopReason = (typeof LISTENER_STOP_REASONS)[number];

/** Ingest reject reasons that mean someone else uses the read-only working account (E-19). */
export const BANK_CHAT_ANOMALY_REASONS = ['OUTGOING', 'FOREIGN_SENDER', 'NOT_BOT'] as const;
export type BankChatAnomalyReason = (typeof BANK_CHAT_ANOMALY_REASONS)[number];

const LISTENER_DOWN_REF = /^(\d{1,15})_\d{1,10}$/;
const LISTENER_STOPPED_REF = /^([A-Z_]{1,20})_\d{1,10}$/;
const ANOMALY_REF = /^(HUMO_BOT|UZCARD_BOT)_(OUTGOING|FOREIGN_SENDER|NOT_BOT)_\d{1,20}$/;

/** The outage start of a `listenerDown` refId, or null (the older hour-only form). */
export function parseListenerDownRef(refId: string): Date | null {
  const since = LISTENER_DOWN_REF.exec(refId)?.[1];
  return since === undefined ? null : new Date(Number(since));
}

/** The reason of a `listenerStopped` refId, or null. */
export function parseListenerStoppedRef(refId: string): ListenerStopReason | null {
  const reason = LISTENER_STOPPED_REF.exec(refId)?.[1];
  return LISTENER_STOP_REASONS.find((r) => r === reason) ?? null;
}

/** Source and reason of a `bankChatAnomaly` refId, or null. */
export function parseBankChatAnomalyRef(
  refId: string,
): { readonly source: BankFeedSource; readonly reason: BankChatAnomalyReason } | null {
  const match = ANOMALY_REF.exec(refId);
  const reason = BANK_CHAT_ANOMALY_REASONS.find((r) => r === match?.[2]);
  const source = match?.[1];
  if (reason === undefined || (source !== 'HUMO_BOT' && source !== 'UZCARD_BOT')) return null;
  return { source, reason };
}

const FOREIGN_CHAT_REF = /^(HUMO_BOT|UZCARD_BOT)_\d+$/;

/** The source of a `foreignChat` refId, or null for anything else. */
export function parseForeignChatAlertRef(refId: string): BankFeedSource | null {
  if (!FOREIGN_CHAT_REF.test(refId)) return null;
  return refId.startsWith('HUMO_BOT_') ? 'HUMO_BOT' : 'UZCARD_BOT';
}

// Prisma cuid2 ids never contain '_', so the first '_' of a composite refId ends the id.
const COMPOSITE_REF = /^([A-Za-z0-9]{1,40})_([A-Za-z0-9_]{1,40})$/;

/**
 * The leading row id of a composite `refId` (`<cardId>_<epoch>`,
 * `<userId>_<ledgerEntryId>`): the notify renderer reads the card or the user back from it.
 * Null for anything that is not `<id>_<suffix>`.
 */
export function refIdSubject(refId: string): string | null {
  const match = COMPOSITE_REF.exec(refId);
  return match?.[1] ?? null;
}

/**
 * Stable per logical notification: `topup-<paymentId>` and `alert-<alert>-<refId>`. BullMQ
 * drops an `add()` whose id still exists, so a retried producer notifies once. An alert that
 * must repeat for the same row (listener still down an hour later) puts a time bucket in `refId`.
 */
export function notifyJobId(job: NotifyJob): string {
  return job.kind === 'OWNER_ALERT'
    ? tgOutboxJobId('alert', job.alert, job.refId)
    : tgOutboxJobId('topup', job.refId);
}

/**
 * The daily reconciliation's audit row (docs/05 §10): the worker writes it, the API's notify
 * renderer reads the latest one of the day for `reconcileOk` / `reconcileMismatch`.
 * `targetId` = `tashkentDayKey(now)` (yyyymmdd), which is also the alert `refId`.
 */
export const RECONCILE_AUDIT = {
  actorType: 'SYSTEM',
  action: 'PAYMENT_RECONCILE',
  targetType: 'PaymentReconcileDay',
} as const;

/** How the 48 h history re-scan went: only `ok` lets the day be reported as clean. */
export const RECONCILE_HISTORY_STATES = ['ok', 'unavailable', 'failed'] as const;
export type ReconcileHistoryState = (typeof RECONCILE_HISTORY_STATES)[number];

/**
 * Why a source's re-scan was not `ok` (`after.history.<source>.reason`; the mismatch alert
 * lists them as `<source>=<reason>`): unavailable — NO_CLIENT (no client wired), NOT_PINNED
 * (no bot id) or NOT_LEADER (this worker does not lead the bank feed, D-52: only the leader is
 * connected); failed — CLIENT_ERROR (the client threw), NO_PROGRESS (a page that does not move
 * the cursor), TOO_LONG (more than the page limit), FOREIGN_CHAT (a page carried another chat's
 * message: the client broke its contract, a security event).
 */
export const RECONCILE_HISTORY_REASONS = [
  'NO_CLIENT',
  'NOT_PINNED',
  'NOT_LEADER',
  'CLIENT_ERROR',
  'NO_PROGRESS',
  'TOO_LONG',
  'FOREIGN_CHAT',
] as const;
export type ReconcileHistoryReason = (typeof RECONCILE_HISTORY_REASONS)[number];

/**
 * The mismatch kinds the reconciliation counts (`after.mismatches.<code>`, whole numbers; the
 * alert lists the non-zero ones by these codes, in this order):
 * - recovered: a message found only by the history re-scan (now stored and queued);
 * - missingOutcome: a stored message still without a decision (a stalled or lost job);
 * - creditUnaccounted: a card's received CREDIT sum differs from CREDITED + CARD_VERIFIED +
 *   reviewed (counted per card);
 * - paymentWithoutMessage: a P2P_CARD Payment with no bank message;
 * - chainBreak: a recomputed balance-chain gap not accepted by the owner (CHAIN_ACCEPTED);
 * - pendingPastGrace: a PENDING request whose reservation already ended (the sweep fell behind);
 * - lateOverLimit: D-42 residual risk, a payment after `expiresAt + TOPUP_CAPACITY_HOLD_SEC`
 *   on a card now over its receive limit;
 * - reviewOpenOver24h: a payment review still OPEN a day after it was opened (S9 I-1: money
 *   waiting for the owner is never reported as a clean day);
 * - purgeOverdue: a raw bank text still kept more than PURGE_OVERDUE_DAYS after its
 *   `purgeAfter` (D-37 (10)): the daily `bank-text-purge` job is failing or falling behind.
 */
export const RECONCILE_MISMATCH_CODES = [
  'recovered',
  'missingOutcome',
  'creditUnaccounted',
  'paymentWithoutMessage',
  'chainBreak',
  'pendingPastGrace',
  'lateOverLimit',
  'reviewOpenOver24h',
  'purgeOverdue',
] as const;
export type ReconcileMismatchCode = (typeof RECONCILE_MISMATCH_CODES)[number];

/** Days past `purgeAfter` after which a kept raw text is a `purgeOverdue` mismatch. */
export const PURGE_OVERDUE_DAYS = 2;
