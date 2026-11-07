// Job contract for the `notify` queue (QUEUES.NOTIFY): the worker says WHAT happened, the API
// decides how it reads. The payload carries ids only; the API loads the amount and the user's
// language from the database, renders the text, escapes it and puts it on `tg-outbox`.
// That keeps user-facing text and the bot token out of the worker (CLAUDE.md invariant 7)
// and keeps money amounts out of the notify jobs, which stay NOTIFY_DEDUPE_SEC (30 days) for
// deduplication. The rendered text (with the amount and balance) exists only in the tg-outbox
// job, which is kept one day.
import { z } from 'zod';
import { BankFeedAlertKindSchema } from './payments/bank-feed';
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
} as const;

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
