import type { Prisma } from '@repo/db';
import { NOTIFY_DEDUPE_SEC, type OrderStatus } from '@repo/shared';

// Pure reads of the hint facts the TON module keeps on an attempt (`response.ton.hint`, and the
// `late` mark of an OTHER_TRANSFER), for the late-facts step's hint walk (phase 5 S9f / S9i). Two
// decided hints call for an owner alert that is queued again on every lap of the walk, from the
// kept fact, so an enqueue lost right after the decision is made good (BullMQ drops a repeat of the
// same job id):
// - FOREIGN_MESSAGE (S9f SA N-2): `tonSeqnoUnmatched`, refId foreignRef(<transfer>);
// - OTHER_TRANSFER (S9i review R1): `tonLateConfirmed` `<T1>_<auditId>` for the transfer the hint
//   marked, while its order is settled (otherTransferLateNotices), only when T1 really holds the
//   mark this very hint wrote.
// Both only while the decided hint's audit row is younger than HINT_REPEAT_MAX_AGE_MS on the
// database clock (S9i review R2, re-review M2): the notify dedupe less one day, the same margin as
// the API's EFFECTS_REPLAY_MAX_AGE_MS, so the repeats stop before BullMQ can forget the job id even
// with some clock drift (past it a repeat would reach the owner again every lap for good).
// A known edge (re-review M6): the repeats look at the LATEST hint kept on T2. When the owner gives
// T2 a new hint, that verdict replaces the old one and the old mark's repeat stops (its first send,
// and any repeat queued until then, stand).

export interface DecidedHint {
  readonly auditId: string;
  readonly code: string | null;
  /** OTHER_TRANSFER: the transfer whose message the hinted transaction carries. */
  readonly otherTransferId: string | null;
}

const OTHER_MESSAGE = /^OTHER_TRANSFER\(([A-Za-z0-9]{1,40})\)$/;

function objectOf(value: Prisma.JsonValue | undefined): Prisma.JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

/** The attempt's `response.ton` facts ({} when there are none). */
export function tonOf(response: Prisma.JsonValue | null): Prisma.JsonObject {
  return objectOf(objectOf(response ?? undefined)?.['ton']) ?? {};
}

/** The hint verdict the TON module last kept on this attempt, or null. */
export function decidedHintOf(response: Prisma.JsonValue | null): DecidedHint | null {
  const hint = objectOf(tonOf(response)['hint']);
  const auditId = hint?.['auditId'];
  if (typeof auditId !== 'string') return null;
  const code = hint?.['code'];
  const message = hint?.['message'];
  const other = typeof message === 'string' ? OTHER_MESSAGE.exec(message) : null;
  return {
    auditId,
    code: typeof code === 'string' ? code : null,
    otherTransferId: other?.[1] ?? null,
  };
}

const DAY_MS = 86_400_000;

/** How long a decided hint's alert is queued again: the notify dedupe less one day (M2). */
export const HINT_REPEAT_MAX_AGE_MS = NOTIFY_DEDUPE_SEC * 1_000 - DAY_MS;

/** The decided hint's audit row is still inside the repeat window (database clock). */
export function insideDedupeWindow(auditCreatedAt: Date, nowMs: number): boolean {
  return nowMs - auditCreatedAt.getTime() < HINT_REPEAT_MAX_AGE_MS;
}

/** The other transfer's `late` fact is the mark this hint wrote (ton-late-other.ts). */
export function isMarkOf(
  response: Prisma.JsonValue | null,
  auditId: string,
  hintedTransferId: string,
): boolean {
  const late = objectOf(tonOf(response)['late']);
  return (
    late?.['outcome'] === 'OTHER_TRANSFER' &&
    late['auditId'] === auditId &&
    late['hintedTransferId'] === hintedTransferId
  );
}

/** One OTHER_TRANSFER mark whose owner alert the step queues again (when the order is settled). */
export interface OtherLateItem {
  /** The marked transfer (T1). */
  readonly transferId: string;
  readonly auditId: string;
  readonly orderStatus: OrderStatus;
}
