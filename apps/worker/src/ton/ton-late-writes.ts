import type { Prisma, Tx } from '@repo/db';
import { bounceLate, type LateBounce } from './ton-late-bounce';
import {
  NOTHING,
  WRITTEN,
  addFactOnce,
  addFacts,
  chainFields,
  databaseNow,
  tonOf,
  txFacts,
  type LateRows,
  type LateWrite,
} from './ton-late-rows';
import type { SuspectDetail } from './ton-classifier';
import { markOtherTransfer, type OtherTransfer } from './ton-late-other';
import { ONCHAIN_FAILED_DETAILS } from './ton-onchain-failed';
import type { LockedAttempt } from './ton-row-locks';
import type { OurTxFacts } from './ton-tx-facts';
import type { HintRejectCode } from './ton-tx-hint.verifier';

export type { LateRows, LateWrite, LockedTransfer } from './ton-late-rows';
export type { ReturnOutOfRange } from './ton-late-bounce';

// The writes of TonLateRepository (phase 5 S9f, D-64 (7)) on rows it has already locked (order ->
// attempt -> transfer). A late fact is written on the transfer and on its attempt's
// `response.ton` only: it never moves money and never closes an order. The only order move is the
// review one S5 makes for a bounce (ton-late-bounce.ts). Every write first checks the locked rows
// still allow it (the state may have moved since the chain was read) and writes nothing a second
// time: a repeated look returns `written: false`.
// - LATE_CONFIRMED / HINT_ACCEPTED: EXPIRED or CONSUMED_UNMATCHED -> CONFIRMED with OUR
//   transaction (`confirmedAt` = the database clock of the write: the late bounce watch counts from
//   it, review F10), and the `late` mark (audit I-5): the order reconciler never takes such a
//   transfer as a proof, only the owner resolves the order (Z6 is manual, owner 2026-11-18);
// - LATE_SUSPECT: our message was found executed but it paid nothing as signed; LATE_SEQNO_HELD:
//   it paid, but a live transfer holds the seqno, so the row cannot become CONFIRMED (the unique
//   index refused it once). Both keep the transfer's state (no edge exists); the `late` mark says
//   the "not sent" was wrong and ends the late scan (one alert, no hourly repeat: review F3);
// - HINT_REJECTED: the owner's hint did not hold; the transfer keeps its state, the code is kept
//   (with the other transfer's id when the hinted transaction carries ITS message, F3), and that
//   other transfer gets its own `late` fact (OTHER_TRANSFER, CR M2: ton-late-other.ts);
// - LATE_BOUNCE: ton-late-bounce.ts (BOUNCED only for the order's one live payout, F1);
// - LATE_DESTINATION: the destination of a CONFIRMED transfer aborted it without a bounce, or the
//   transaction recorded on it did not pay as signed (F4, owner 2026-11-18): `lateDestination`
//   facts only (written once); the reconciler treats them like a SUSPECT fact;
// - ONCHAIN_FAILED: SIGNED/BROADCAST -> ONCHAIN_FAILED for the very transaction the SUSPECT fact
//   names, while the order is NEEDS_REVIEW (its exit is the owner's TON_NOT_DEBITED proof).
// This file never writes EXPIRED (item 23: only ton-outcome-writes.ts does).

export type LateDestinationVerdict = 'DESTINATION_ABORTED' | 'NOT_PAID';

export type LateOutcome =
  | { readonly kind: 'LATE_CONFIRMED'; readonly tx: OurTxFacts }
  | { readonly kind: 'HINT_ACCEPTED'; readonly tx: OurTxFacts; readonly auditId: string }
  | { readonly kind: 'LATE_SUSPECT'; readonly tx: OurTxFacts; readonly detail: SuspectDetail }
  | { readonly kind: 'LATE_SEQNO_HELD'; readonly tx: OurTxFacts }
  | {
      readonly kind: 'HINT_REJECTED';
      readonly auditId: string;
      readonly code: HintRejectCode;
      /** OTHER_TRANSFER: the transfer whose message the hinted transaction carries (CR M2). */
      readonly other?: OtherTransfer;
    }
  | LateBounce
  | {
      readonly kind: 'LATE_DESTINATION';
      readonly verdict: LateDestinationVerdict;
      readonly destTxHash: string | null;
    }
  | { readonly kind: 'ONCHAIN_FAILED'; readonly tx: OurTxFacts; readonly sources: number };

function isNotSent(status: string): boolean {
  return status === 'EXPIRED' || status === 'CONSUMED_UNMATCHED';
}

async function confirmLate(
  tx: Tx,
  rows: LateRows,
  outcome: Extract<LateOutcome, { readonly kind: 'LATE_CONFIRMED' | 'HINT_ACCEPTED' }>,
): Promise<LateWrite> {
  const from = rows.transfer.status;
  const hinted = outcome.kind === 'HINT_ACCEPTED';
  if (!isNotSent(from) || (hinted && from !== 'CONSUMED_UNMATCHED')) return NOTHING;
  await tx.tonTransfer.update({
    where: { id: rows.transferId },
    data: { status: 'CONFIRMED', ...chainFields(outcome.tx, await databaseNow(tx)) },
  });
  const via = hinted ? { via: 'HINT', auditId: outcome.auditId } : { via: 'SCAN' };
  await addFacts(tx, rows, {
    late: { from, outcome: 'CONFIRMED', ...via, ...txFacts(outcome.tx) },
    ...(hinted ? { hint: { auditId: outcome.auditId, verdict: 'ACCEPTED' } } : {}),
  });
  return WRITTEN;
}

/** The SUSPECT fact S5 kept on the attempt names exactly this transaction, of a failing kind. */
function suspectNames(attempt: LockedAttempt, ourTx: OurTxFacts): boolean {
  const suspect = tonOf(attempt.response)['suspect'];
  if (typeof suspect !== 'object' || suspect === null || Array.isArray(suspect)) return false;
  const detail = ONCHAIN_FAILED_DETAILS.find((d) => d === suspect['detail']);
  return (
    detail !== undefined &&
    suspect['txHash'] === ourTx.hash &&
    suspect['txLt'] === ourTx.lt.toString()
  );
}

async function failOnChain(
  tx: Tx,
  rows: LateRows,
  outcome: Extract<LateOutcome, { readonly kind: 'ONCHAIN_FAILED' }>,
): Promise<LateWrite> {
  const status = rows.transfer.status;
  if (status !== 'SIGNED' && status !== 'BROADCAST') return NOTHING;
  const attempt = rows.attempt;
  if (rows.order?.status !== 'NEEDS_REVIEW' || attempt === null) return NOTHING;
  if (!suspectNames(attempt, outcome.tx)) return NOTHING;
  const chainTime = new Date(outcome.tx.utime * 1_000);
  await tx.tonTransfer.update({
    where: { id: rows.transferId },
    data: { status: 'ONCHAIN_FAILED', ...chainFields(outcome.tx, chainTime) },
  });
  await addFacts(tx, rows, {
    onchainFailed: {
      txHash: outcome.tx.hash,
      txLt: outcome.tx.lt.toString(),
      outMsgCount: 0,
      sources: outcome.sources,
    },
  });
  return WRITTEN;
}

/** A `late` mark on a transfer that keeps its "not sent" state (SUSPECT, seqno held). */
function notSentMark(
  rows: LateRows,
  outcome: Extract<LateOutcome, { readonly kind: 'LATE_SUSPECT' | 'LATE_SEQNO_HELD' }>,
): Prisma.InputJsonObject | null {
  const from = rows.transfer.status;
  if (!isNotSent(from)) return null;
  const detail = outcome.kind === 'LATE_SUSPECT' ? { detail: outcome.detail } : {};
  const result = outcome.kind === 'LATE_SUSPECT' ? 'SUSPECT' : 'SEQNO_HELD';
  return { from, outcome: result, via: 'SCAN', ...detail, ...txFacts(outcome.tx) };
}

export async function writeLate(tx: Tx, rows: LateRows, outcome: LateOutcome): Promise<LateWrite> {
  switch (outcome.kind) {
    case 'LATE_CONFIRMED':
    case 'HINT_ACCEPTED':
      return confirmLate(tx, rows, outcome);
    case 'LATE_SUSPECT':
    case 'LATE_SEQNO_HELD': {
      const late = notSentMark(rows, outcome);
      return late === null ? NOTHING : addFactOnce(tx, rows, 'late', late);
    }
    case 'HINT_REJECTED': {
      if (rows.transfer.status !== 'CONSUMED_UNMATCHED') return NOTHING;
      const other = outcome.other;
      const hint = {
        auditId: outcome.auditId,
        verdict: 'REJECTED',
        code: outcome.code,
        ...(other === undefined ? {} : { message: `OTHER_TRANSFER(${other.transferId})` }),
      };
      const decided = await addFacts(tx, rows, { hint });
      // CR M2: the other transfer's message is on the chain: its own `late` fact (ton-late-other.ts).
      const marked =
        other === undefined ? NOTHING : await markOtherTransfer(tx, rows, other, outcome.auditId);
      if (marked.written) return { ...WRITTEN, notices: marked.notices ?? [] };
      return decided ? WRITTEN : NOTHING;
    }
    case 'LATE_BOUNCE':
      return bounceLate(tx, rows, outcome);
    case 'LATE_DESTINATION': {
      if (rows.transfer.status !== 'CONFIRMED') return NOTHING;
      const { verdict, destTxHash } = outcome;
      const orderStatus = rows.order?.status ?? 'NONE';
      return addFactOnce(tx, rows, 'lateDestination', { verdict, destTxHash, orderStatus });
    }
    case 'ONCHAIN_FAILED':
      return failOnChain(tx, rows, outcome);
  }
}
