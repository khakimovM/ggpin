import type { Prisma } from '@repo/db';
import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import { z } from 'zod';

// D-60 (2): a transfer is EXPIRED (provably never sent: the one state that lets the fulfillment
// core pay again or refund) only after TWO consistent observations separated in time. One
// observation is a COMPLETE scan of the wallet's transactions anchored at one account state in
// which the seqno is still ours and the chain time is past validUntil + the margin, taken again
// over a NEW connection (audit M-1 (b)), with the database clock past that point too. One stale
// or inconsistent provider answer (audit M1, E4: a state from before our transaction, served with
// a current chain time) is therefore never enough.
//
// The first observation of an ORDER transfer is kept in FulfillmentAttempt.response.ton.expiry
// (a JSON column that is mutable by design, migration 10; no new column): it is written under the
// order and attempt row locks, survives a restart, and stays next to the final proof
// `{ first, second }` as evidence for the reconciler and the owner (S9/S10); it stays there even
// when the transfer is CONFIRMED later (review n3). A SELFTEST transfer has no attempt: its first
// observation lives in the memory of the one CLI process that watches it (a crash only starts the
// count again, the safe direction). Audit L-3: an observation names its transfer, message and
// validUntil, and a stored first that does not match them, or was taken before validUntil + the
// margin, counts as no first at all (the next observation becomes the first: the safe direction).
//
// Both observations still come from ONE provider. A second, independent source is mandatory
// before mainnet ("mainnet'dan oldin ikkinchi manba majburiy", docs/06): TON_EXPIRY_WITNESSES
// takes its reader, and the env check refuses a live mainnet worker until one exists.

export interface ExpiryObservation {
  /** The transfer, its signed message and its validUntil (epoch ms) the observation is about. */
  readonly transferId: string;
  readonly extMsgHash: string;
  readonly validUntilMs: number;
  /** The chain time (unix s) of the account state the observation was taken at. */
  readonly chainTime: number;
  /** The database clock (epoch ms) right after that state was read. */
  readonly atMs: number;
  /** The wallet's seqno in that state: the transfer's own seqno. */
  readonly seqno: number;
  /** The logical time of that state's last transaction (0 for an account without any). */
  readonly lastTxLt: bigint;
}

/**
 * N, the least time between the two observations: 30 s is several masterchain blocks, longer
 * than the lag of a provider's cache or of one backend node behind its load balancer, so the
 * second answer is a fresh one; and the whole proof (TON_SEND_VALID_SEC 60 s + the 60 s margin
 * + 30 s, plus the clock skew allowed at signing) still ends inside TON_CONFIRM_TIMEOUT_MS, so a
 * lost message ends EXPIRED in the sender's own wait instead of in NEEDS_REVIEW. The env check
 * keeps that true (review m2).
 */
export const DEFAULT_EXPIRY_GAP_SEC = 30;

const MARGIN_SEC = Math.ceil(TON_NOT_SENT_MARGIN_MS / 1_000);

/**
 * The second observation confirms the first: same seqno, at least `gapSec` later by the database
 * clock, a strictly later chain time, and a state not older than the first one's.
 */
export function confirmsExpiry(
  first: ExpiryObservation,
  second: ExpiryObservation,
  gapSec: number,
): boolean {
  return (
    second.seqno === first.seqno &&
    second.atMs - first.atMs >= gapSec * 1_000 &&
    second.chainTime > first.chainTime &&
    second.lastTxLt >= first.lastTxLt
  );
}

/**
 * `first` may stand as the first observation of the message `next` is about (audit L-3): the same
 * transfer, message, validUntil and seqno, taken past validUntil + the margin by both clocks, and
 * not after `next` by the database clock (a clock stepped back must not block the proof for good).
 */
export function isFirstFor(first: ExpiryObservation, next: ExpiryObservation): boolean {
  const sinceMs = first.validUntilMs + TON_NOT_SENT_MARGIN_MS;
  return (
    first.transferId === next.transferId &&
    first.extMsgHash === next.extMsgHash &&
    first.validUntilMs === next.validUntilMs &&
    first.seqno === next.seqno &&
    first.atMs >= sinceMs &&
    first.atMs <= next.atMs &&
    first.chainTime > Math.floor(first.validUntilMs / 1_000) + MARGIN_SEC
  );
}

export function observationJson(observation: ExpiryObservation): Prisma.InputJsonObject {
  return {
    transferId: observation.transferId,
    extMsgHash: observation.extMsgHash,
    validUntilMs: observation.validUntilMs,
    chainTime: observation.chainTime,
    atMs: observation.atMs,
    seqno: observation.seqno,
    lastTxLt: observation.lastTxLt.toString(),
  };
}

const ObservationSchema = z
  .object({
    transferId: z.string().min(1).max(64),
    extMsgHash: z.string().regex(/^[0-9a-f]{64}$/),
    validUntilMs: z.number().int().positive(),
    chainTime: z.number().int().positive(),
    atMs: z.number().int().positive(),
    seqno: z.number().int().nonnegative(),
    lastTxLt: z.string().regex(/^\d{1,20}$/),
  })
  .strict();

const StoredExpirySchema = z.object({
  ton: z.object({ expiry: z.object({ first: ObservationSchema }) }),
});

/**
 * The first observation kept in an attempt's response for the message `next` is about, or null:
 * none, not readable, or not one for that message (audit L-3, `isFirstFor`).
 */
export function storedFirstObservation(
  response: unknown,
  next: ExpiryObservation,
): ExpiryObservation | null {
  const parsed = StoredExpirySchema.safeParse(response);
  if (!parsed.success) return null;
  const stored = parsed.data.ton.expiry.first;
  const first = { ...stored, lastTxLt: BigInt(stored.lastTxLt) };
  return isFirstFor(first, next) ? first : null;
}
