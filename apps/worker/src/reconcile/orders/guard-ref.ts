import { notifyJobSchema, refIdSubject, type FulfillmentAlertKind } from '@repo/shared';

// The refId of the reconciler's owner alerts that must repeat for the SAME order (plan §12): a
// notify job id is deduped for 30 days, so `<orderId>` alone would swallow a second episode in
// silence. The episode is the hour of the DATABASE clock at the tick: while a guard keeps refusing
// the owner hears it again every hour (never more often), and the API renderer still reads the
// order back from the ref (`refIdSubject`: `<orderId>_<scope>_<hour>`). The same holds for a
// CONSUMED_UNMATCHED transfer left in review (audit I-2): `<transferId>_cu_<hour>`, read back as
// the transfer. A stuck order lease (S9d, Q-17) is `<orderId>_lock_<hour>` on `needsReview`: the
// plain order id stays free for the order's real NEEDS_REVIEW alert. An order whose re-queues are
// used up (S9d fix F8) is `<orderId>_abandoned_<day>` on `needsReview`: at most once a day, and
// again on a later day after the 24 h abandon window ran out (the settle's own
// `<orderId>_abandoned` stays as it is). The tick's clock is the database's; the order events it is
// compared with carry the writing process's clock (see order-sweeps.repository.ts).

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * What the episode is about: a guard refusal of the NEEDS_REVIEW resolution or of a TON transfer
 * check (subject: the order), a CONSUMED_UNMATCHED transfer awaiting the owner (the transfer), or
 * an order lease stuck while nothing runs, or an order whose re-queues are used up (the order).
 */
export type GuardScope = 'review' | 'ton' | 'cu' | 'lock' | 'abandoned';

const ALERT_OF: Readonly<Record<GuardScope, FulfillmentAlertKind>> = {
  review: 'reconcileGuardRefused',
  ton: 'reconcileGuardRefused',
  cu: 'tonConsumedUnmatched',
  lock: 'needsReview',
  abandoned: 'needsReview',
};

/** How long one episode lasts: an hour, a day for the used-up re-queues. */
const PERIOD_OF: Readonly<Record<GuardScope, number>> = {
  review: HOUR_MS,
  ton: HOUR_MS,
  cu: HOUR_MS,
  lock: HOUR_MS,
  abandoned: DAY_MS,
};

/**
 * `<subjectId>_<scope>_<period>` (the hour, or the day for `abandoned`), or null when the id cannot be part of an alert id (not a plain id
 * of at most 40 characters, or the whole ref would not pass the notify schema's 64): the caller
 * logs it instead, a malformed id is never sent.
 */
export function episodeRef(subjectId: string, scope: GuardScope, nowMs: number): string | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  const ref = `${subjectId}_${scope}_${String(Math.floor(nowMs / PERIOD_OF[scope]))}`;
  if (refIdSubject(ref) !== subjectId) return null;
  const job = notifyJobSchema.safeParse({
    kind: 'OWNER_ALERT',
    alert: ALERT_OF[scope],
    refId: ref,
  });
  return job.success ? ref : null;
}
