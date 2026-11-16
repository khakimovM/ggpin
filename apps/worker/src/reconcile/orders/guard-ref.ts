import { notifyJobSchema, refIdSubject } from '@repo/shared';

// The refId of the reconciler's owner alerts that must repeat for the SAME order (plan §12): a
// notify job id is deduped for 30 days, so `<orderId>` alone would swallow a second episode in
// silence. The episode is the hour of the DATABASE clock at the tick: while a guard keeps refusing
// the owner hears it again every hour (never more often), and the API renderer still reads the
// order back from the ref (`refIdSubject`: `<orderId>_<scope>_<hour>`).

const HOUR_MS = 3_600_000;

/** Where the refusal happened: the NEEDS_REVIEW resolution or a TON transfer check. */
export type GuardScope = 'review' | 'ton';

/**
 * `<orderId>_<scope>_<hour>`, or null when the order id cannot be part of an alert id (not a plain
 * id of at most 40 characters, or the whole ref would not pass the notify schema's 64): the caller
 * logs it instead, a malformed id is never sent.
 */
export function episodeRef(orderId: string, scope: GuardScope, nowMs: number): string | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  const ref = `${orderId}_${scope}_${String(Math.floor(nowMs / HOUR_MS))}`;
  if (refIdSubject(ref) !== orderId) return null;
  const job = notifyJobSchema.safeParse({
    kind: 'OWNER_ALERT',
    alert: 'reconcileGuardRefused',
    refId: ref,
  });
  return job.success ? ref : null;
}
