import {
  FULFILL_ORDER_LOCK_DURATION_MS,
  TON_BOUNCE_FEE_MAX_NANO,
  TON_NOT_SENT_MARGIN_MS,
  proofIsOperatorOnly,
  proofNeedsOwnerOtp,
  type NeedsReviewOutcome,
  type NeedsReviewProof,
} from '@repo/shared';
import { ReviewProofError } from './errors.js';
import {
  UNRESOLVED_ATTEMPT_STATUSES,
  deliveryProblem,
  type PayoutAttempt,
  type PayoutState,
  type PayoutTransfer,
} from './payout-state.js';
import type { VerifiedResolver } from './review-resolver.js';

export type { ReviewResolver } from './review-resolver.js';

/** What the proof lets `resolveNeedsReview` do in the same transaction. */
export interface ProofBinding {
  /** The unresolved attempts to close (to CONFIRMED / FAILED). */
  readonly attemptsToClose: readonly PayoutAttempt[];
  /**
   * The transfers an owner's proof was bound to (TON_NOT_DEBITED, TON_BOUNCED,
   * TON_UNMATCHED_RESOLVED): the refund may ignore exactly these (owner decisions A1-A4).
   */
  readonly provenTransferIds: readonly string[];
  /** Set for `SENT_ELSEWHERE`: the wallet is compromised, the caller raises the critical alert. */
  readonly securityAlert: 'tonWalletCompromised' | null;
}

interface BindInput {
  readonly orderId: string;
  readonly to: NeedsReviewOutcome;
  readonly proof: NeedsReviewProof;
  /** Verified by `verifyResolver`: `null` is the reconciler, otherwise an OWNER (role from the database). */
  readonly resolver: VerifiedResolver;
  readonly state: PayoutState;
  /** The DATABASE's clock (`readDatabaseNow`), the one the SQL guards use. Never a caller's. */
  readonly now: Date;
}

const isUnresolved = (attempt: PayoutAttempt): boolean =>
  UNRESOLVED_ATTEMPT_STATUSES.includes(attempt.status);

function findTransfer(
  state: PayoutState,
  proof: { readonly extMsgHash: string; readonly walletAddress: string },
): PayoutTransfer | undefined {
  return state.transfers.find(
    (t) => t.extMsgHash === proof.extMsgHash && t.walletAddress === proof.walletAddress,
  );
}

/**
 * Binds a proof to the order's OWN rows, which the caller has read under lock (audit H1, review
 * F6). A proof that merely agrees with itself proves nothing: it must name a transfer or an
 * attempt of THIS order, in the state and with the numbers the rows have, and no other payout of
 * the order may have gone out. Anything else is `ReviewProofError` (MISMATCH, LIVE_PAYOUT, ...) and
 * nothing is written.
 *
 * Who may carry it: the reconciler only TON_TX and TON_NOT_SENT (`proofIsOperatorOnly`); the owner
 * proofs and MANUAL need an operator whose OTP was verified (`proofNeedsOwnerOtp`, rules/60). The
 * operator is already a verified OWNER here (`verifyResolver` read the role from the database).
 *
 * - TON_TX (-> DELIVERED): the transfer of this order with that message hash and wallet is
 *   CONFIRMED with exactly that `txHash` and `lt`; its attempt is in flight or CONFIRMED, never
 *   FAILED, and no OTHER attempt of the order is unresolved (audit N3).
 * - TON_NOT_SENT (-> FAILED): the transfer is EXPIRED with exactly that `seqno` and `validUntil`;
 *   the database clock is at least `validUntil + TON_NOT_SENT_MARGIN_MS` and the wallet was
 *   checked no later than that clock (no skew allowed, audit N2).
 * - TON_NOT_DEBITED (-> FAILED, A2): the transfer (by id) is ONCHAIN_FAILED with that `txHash` and
 *   `txLt`: our transaction, which sent nothing.
 * - TON_BOUNCED (-> FAILED, A1): the transfer is BOUNCED with that `txHash` and `txLt`; the returned
 *   amount lies in `[sent - TON_BOUNCE_FEE_MAX_NANO, sent]`. (That the return hash is new and is not
 *   one of our own transactions is checked by the caller, which can query.)
 * - TON_UNMATCHED_RESOLVED (-> FAILED, A3): the transfer is CONSUMED_UNMATCHED; only the owner's CLI
 *   carries it (`ACTOR_MISMATCH` for an ADMIN, Z2); `SENT_ELSEWHERE`
 *   also asks the caller for the critical `tonWalletCompromised` alert.
 *   For the three owner proofs: no other transfer may be alive (all others EXPIRED), no attempt may
 *   be CONFIRMED, and the only unresolved attempt is the transfer's own.
 * - FRAGMENT_STATUS (-> DELIVERED, operator only): `requestRef` is the `externalRef` of one attempt,
 *   which is in flight or CONFIRMED, whose transfer is not EXPIRED (a message that never landed
 *   cannot have paid Fragment: audit Y4), and no other attempt is unresolved (audit N3, review R5).
 * - MANUAL (an owner's evidence, OTP): either exit; to FAILED not while a transfer is not EXPIRED, an
 *   attempt is CONFIRMED, or a transfer-less SENDING attempt is younger than
 *   `lockDuration + margin` (its worker may still be running: a heuristic, the DB guards are the
 *   barrier).
 * Every exit to DELIVERED must also satisfy the delivery rule (`deliveryProblem`, audit Y1): after
 * the attempts are closed to CONFIRMED there is a CONFIRMED one, none waits, and no transfer is
 * signed, broadcast, consumed-unmatched or bounced.
 * Returns the unresolved attempts to close (to CONFIRMED / FAILED) with the order.
 */
export function bindProof(input: BindInput): ProofBinding {
  const { orderId, to, proof, resolver, state, now } = input;
  const mismatch = () => new ReviewProofError('MISMATCH', orderId);
  const live = () => new ReviewProofError('LIVE_PAYOUT', orderId);
  if (proofIsOperatorOnly(proof) && resolver === null) {
    throw new ReviewProofError('ACTOR_MISMATCH', orderId);
  }
  if (proofNeedsOwnerOtp(proof) && resolver?.otpVerified !== true) {
    throw new ReviewProofError('OWNER_REQUIRED', orderId);
  }
  const unresolved = state.attempts.filter(isUnresolved);
  let toClose: readonly PayoutAttempt[];
  const provenTransferIds: string[] = [];
  let securityAlert: ProofBinding['securityAlert'] = null;

  // The attempt a "sent" proof is about must be ALIVE (an attempt is CONFIRMED only together with the
  // delivery, so a CONFIRMED one cannot exist in NEEDS_REVIEW: D-59 N1) and the only unresolved one.
  const closeOnlyOwn = (own: PayoutAttempt | undefined): readonly PayoutAttempt[] => {
    if (own === undefined || !isUnresolved(own)) throw mismatch();
    if (unresolved.some((a) => a.id !== own.id)) throw live();
    return unresolved.filter((a) => a.id === own.id);
  };
  // The owner proofs settle ONE transfer; everything else of the order must be provably not sent.
  const closeAroundTransfer = (transfer: PayoutTransfer): readonly PayoutAttempt[] => {
    if (state.transfers.some((t) => t.id !== transfer.id && t.status !== 'EXPIRED')) throw live();
    if (state.attempts.some((a) => a.status === 'CONFIRMED')) throw live();
    if (unresolved.some((a) => a.id !== transfer.attemptId)) throw live();
    provenTransferIds.push(transfer.id);
    return unresolved;
  };
  const transferOf = (
    transferId: string,
    status: PayoutTransfer['status'],
    chain?: { readonly txHash: string; readonly txLt: string },
  ): PayoutTransfer => {
    const transfer = state.transfers.find((t) => t.id === transferId);
    if (
      transfer === undefined ||
      transfer.status !== status ||
      (chain !== undefined &&
        (transfer.txHash !== chain.txHash ||
          transfer.txLt === null ||
          transfer.txLt !== BigInt(chain.txLt)))
    ) {
      throw mismatch();
    }
    return transfer;
  };

  switch (proof.kind) {
    case 'TON_TX': {
      const transfer = findTransfer(state, proof);
      if (
        transfer === undefined ||
        transfer.status !== 'CONFIRMED' ||
        transfer.txHash !== proof.txHash ||
        transfer.txLt === null ||
        transfer.txLt !== BigInt(proof.lt)
      ) {
        throw mismatch();
      }
      toClose = closeOnlyOwn(state.attempts.find((a) => a.id === transfer.attemptId));
      break;
    }
    case 'TON_NOT_SENT': {
      const transfer = findTransfer(state, proof);
      const validUntil = Date.parse(proof.validUntil);
      if (
        transfer === undefined ||
        transfer.status !== 'EXPIRED' ||
        transfer.seqno !== proof.seqno ||
        transfer.validUntil.getTime() !== validUntil ||
        now.getTime() < validUntil + TON_NOT_SENT_MARGIN_MS ||
        Date.parse(proof.checkedAt) > now.getTime()
      ) {
        throw mismatch();
      }
      if (state.transfers.some((t) => t.id !== transfer.id && t.status !== 'EXPIRED')) throw live();
      if (state.attempts.some((a) => a.status === 'CONFIRMED')) throw live();
      if (unresolved.some((a) => a.id !== transfer.attemptId)) throw live();
      toClose = unresolved;
      break;
    }
    case 'TON_NOT_DEBITED': {
      toClose = closeAroundTransfer(transferOf(proof.transferId, 'ONCHAIN_FAILED', proof));
      break;
    }
    case 'TON_BOUNCED': {
      const transfer = transferOf(proof.transferId, 'BOUNCED', proof);
      const returned = BigInt(proof.returnedNanoTon);
      if (returned > transfer.amountNanoTon) throw mismatch();
      if (returned < transfer.amountNanoTon - TON_BOUNCE_FEE_MAX_NANO) throw mismatch();
      toClose = closeAroundTransfer(transfer);
      break;
    }
    case 'TON_UNMATCHED_RESOLVED': {
      // Only the owner's own CLI (owner decision A3, D-59): never an ADMIN session, whatever its role.
      if (resolver?.type !== 'CLI') throw new ReviewProofError('ACTOR_MISMATCH', orderId);
      toClose = closeAroundTransfer(transferOf(proof.transferId, 'CONSUMED_UNMATCHED'));
      if (proof.finding === 'SENT_ELSEWHERE') securityAlert = 'tonWalletCompromised';
      break;
    }
    case 'FRAGMENT_STATUS': {
      const own = state.attempts.find((a) => a.externalRef === proof.requestRef);
      // The payout of the attempt must have landed: an EXPIRED or failed-on-chain message never
      // did (only the owner's MANUAL proof can deliver beside those, Z3).
      if (
        own !== undefined &&
        state.transfers.some(
          (t) =>
            t.attemptId === own.id && (t.status === 'EXPIRED' || t.status === 'ONCHAIN_FAILED'),
        )
      ) {
        throw mismatch();
      }
      toClose = closeOnlyOwn(own);
      break;
    }
    case 'MANUAL': {
      if (to === 'FAILED') {
        if (state.transfers.some((t) => t.status !== 'EXPIRED')) throw live();
        if (state.attempts.some((a) => a.status === 'CONFIRMED')) throw live();
        const quietFor = FULFILL_ORDER_LOCK_DURATION_MS + TON_NOT_SENT_MARGIN_MS;
        const mayStillRun = unresolved.some(
          (a) =>
            a.status === 'SENDING' &&
            !state.transfers.some((t) => t.attemptId === a.id) &&
            now.getTime() - a.createdAt.getTime() < quietFor,
        );
        if (mayStillRun) throw live();
      }
      toClose = unresolved;
      break;
    }
  }
  if (to === 'DELIVERED') {
    // An attempt is CONFIRMED only with the reference of its payout (DB CHECK); one without it
    // cannot be closed honestly, so a human must look.
    if (toClose.some((a) => a.externalRef === null)) throw mismatch();
    const problem = deliveryProblem(state, toClose, { manual: proof.kind === 'MANUAL' });
    if (problem?.kind === 'NO_CONFIRMED_ATTEMPT' || problem?.kind === 'OWN_TRANSFER_NOT_PAID') {
      throw mismatch();
    }
    if (problem !== null) throw live();
  }
  return { attemptsToClose: toClose, provenTransferIds, securityAlert };
}
