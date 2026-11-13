import {
  NeedsReviewProofSchema,
  orderStatusReasonSchema,
  proofJustifies,
  type NeedsReviewOutcome,
  type NeedsReviewProof,
  type OrderStatusReason,
} from '@repo/shared';
import { assertInTransaction, lockWallet, type Tx } from '../ledger/ledger.js';
import { OrderNotFoundError, ReviewProofError, StaleOrderStateError } from './errors.js';
import { refundFailedOrderWith, type RefundOutcome } from './order-refund.js';
import { applyTransition } from './order-transition-core.js';
import {
  UNRESOLVED_ATTEMPT_STATUSES,
  lockOrderRow,
  readDatabaseNow,
  readPayoutState,
} from './payout-state.js';
import { bindProof } from './review-proof-binding.js';
import { assertProofHashesFresh } from './review-proof-hashes.js';
import { verifyResolver, type ReviewResolver } from './review-resolver.js';

export type { ReviewResolver } from './review-resolver.js';

/** The critical alert a resolution asks its caller to raise after commit (owner decision A3). */
export type SecurityAlertKey = 'tonWalletCompromised';

export interface ResolveNeedsReviewInput {
  readonly orderId: string;
  readonly to: NeedsReviewOutcome;
  /** `unknown` on purpose: it is validated here, so no caller can skip the check by a cast. */
  readonly proof: unknown;
  /**
   * Who vouches for the proof: a trusted parameter, never read from the proof itself. `unknown`-safe:
   * every field is checked with `typeof` and an ADMIN's role is re-read from the database.
   */
  readonly resolver: ReviewResolver;
}

export interface ResolveNeedsReviewResult {
  readonly to: NeedsReviewOutcome;
  readonly userId: string;
  /** Set when `to` is FAILED: the refund leg, for the after-commit cache delete and notification. */
  readonly refund: RefundOutcome | null;
  readonly closedAttemptIds: readonly string[];
  /**
   * `tonWalletCompromised` after a TON_UNMATCHED_RESOLVED proof with `SENT_ELSEWHERE`: the caller
   * (the owner CLI, S10) enqueues that critical owner alert after commit. Otherwise null.
   */
  readonly securityAlert: SecurityAlertKey | null;
}

// The reason NEEDS_REVIEW was entered with survives a failed review; an order whose reason is
// missing or unknown (it should not be) is recorded as the generic one.
function failureReason(stored: string | null): OrderStatusReason {
  const parsed = orderStatusReasonSchema.safeParse(stored);
  return parsed.success ? parsed.data : 'ADAPTER_ERROR';
}

/**
 * The only way out of NEEDS_REVIEW (docs/06 "Phase 5 majburiy talablari"). It cannot be called
 * without a proof that fits the exit AND the order: the proof is validated, then bound to the
 * order's own attempts and TON transfers under lock (`bindProof`, audit H1), and refused with
 * `ReviewProofError` before anything is written when it does not match.
 *
 * Lock order: wallet (FAILED only), then the order row, then attempts and transfers (written
 * through the rows read under those locks); all reads happen after both.
 * The clock is the database's (`readDatabaseNow`); a transfer-less SENDING attempt may only be
 * failed by MANUAL evidence after `lockDuration + margin`, and a transfer that failed on the chain,
 * bounced or lost its seqno only by the owner's TON_NOT_DEBITED / TON_BOUNCED /
 * TON_UNMATCHED_RESOLVED proof (see `bindProof`; owner decisions A1-A4, D-59).
 * In ONE transaction: the unresolved attempt(s) the proof is about are closed (CONFIRMED /
 * FAILED), the NEEDS_REVIEW -> DELIVERED|FAILED transition runs (compare-and-set, so two
 * resolvers cannot both win), for FAILED the refund runs, and LAST the `AuditLog`
 * (`ORDER_REVIEW_RESOLVE`) is written with the proof, the resolver (operator, OS user, OTP
 * flag) and the refund. Doing the transition first means a lost race ends with
 * `StaleOrderStateError` before any audit row exists.
 *
 * The actor of the transition is the RESOLVER, never a field of the proof (review F1, audit M3).
 * The resolver is validated here (`verifyResolver`): an ADMIN's role is re-read from `AdminUser` and
 * must be an active OWNER (audit L3). That the OTP was typed is S10's `requireOwnerConfirmation`;
 * here its outcome (`otpVerified`, the boolean `true`) is demanded where the proof needs it
 * (`proofNeedsOwnerOtp`) and stored.
 */
export function resolveNeedsReview(
  tx: Tx,
  input: ResolveNeedsReviewInput,
): Promise<ResolveNeedsReviewResult> {
  return resolveNeedsReviewAt(tx, input, undefined);
}

/**
 * INTERNAL (not exported from the package index, and the package `exports` keep deep imports out):
 * `resolveNeedsReview` with an injectable clock, so a test can stand on the far side of a margin
 * that the real clock would need minutes to cross. The public function always reads the database's
 * own `now()`, the clock of the SQL guards (audit N2).
 */
export async function resolveNeedsReviewAt(
  tx: Tx,
  input: ResolveNeedsReviewInput,
  clock: Date | undefined,
): Promise<ResolveNeedsReviewResult> {
  assertInTransaction(tx, 'resolveNeedsReview');
  const { orderId, to } = input;
  // JS callers and job payloads are not type-checked: the resolver is validated field by field, and
  // an ADMIN's role comes from the database (audit L2, L3).
  const resolver = await verifyResolver(tx, input.resolver, orderId);
  const parsed = NeedsReviewProofSchema.safeParse(input.proof);
  if (!parsed.success) throw new ReviewProofError('INVALID', orderId);
  const proof: NeedsReviewProof = parsed.data;
  if (!proofJustifies(proof, to)) throw new ReviewProofError('WRONG_KIND', orderId);

  const owner = await tx.order.findUnique({ where: { id: orderId }, select: { userId: true } });
  if (owner === null) throw new OrderNotFoundError(orderId);
  if (to === 'FAILED') await lockWallet(tx, owner.userId);
  await lockOrderRow(tx, orderId);

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { status: true, statusReason: true },
  });
  if (order === null) throw new OrderNotFoundError(orderId);
  if (order.status !== 'NEEDS_REVIEW') throw new StaleOrderStateError(orderId, 'NEEDS_REVIEW');

  await assertProofHashesFresh(tx, orderId, proof);
  const binding = bindProof({
    orderId,
    to,
    proof,
    resolver,
    state: await readPayoutState(tx, orderId),
    now: clock ?? (await readDatabaseNow(tx)),
  });
  for (const attempt of binding.attemptsToClose) {
    const closed = await tx.fulfillmentAttempt.updateMany({
      where: { id: attempt.id, status: { in: [...UNRESOLVED_ATTEMPT_STATUSES] } },
      data:
        to === 'DELIVERED'
          ? { status: 'CONFIRMED' }
          : { status: 'FAILED', error: `review resolved: ${proof.kind}` },
    });
    if (closed.count !== 1) throw new ReviewProofError('MISMATCH', orderId);
  }

  const actorPart =
    resolver === null
      ? { actor: 'reconciler' as const }
      : { actor: 'admin' as const, actorRef: resolver.id };
  const note = `review resolved: ${proof.kind}`;
  await applyTransition(
    tx,
    to === 'DELIVERED'
      ? { orderId, from: 'NEEDS_REVIEW', to, note, ...actorPart }
      : {
          orderId,
          from: 'NEEDS_REVIEW',
          to,
          reason: failureReason(order.statusReason),
          note,
          ...actorPart,
        },
  );
  const refund =
    to === 'FAILED'
      ? await refundFailedOrderWith(
          tx,
          {
            orderId,
            note: `refund after review: ${proof.kind}`,
            // order-state.ts gives FAILED -> REFUNDED to system/admin, not to the reconciler.
            ...(resolver === null
              ? { actor: 'system' as const }
              : { actor: 'admin' as const, actorRef: resolver.id }),
          },
          { provenTransferIds: binding.provenTransferIds },
        )
      : null;

  const operator = resolver;
  await tx.auditLog.create({
    data: {
      actorType: operator?.type ?? 'SYSTEM',
      // D-46: a CLI row has no actor id, the operator is in `after`.
      actorId: operator?.type === 'ADMIN' ? operator.id : null,
      action: 'ORDER_REVIEW_RESOLVE',
      targetType: 'Order',
      targetId: orderId,
      before: { status: 'NEEDS_REVIEW', statusReason: order.statusReason },
      after: {
        proof: { ...proof },
        resolver: operator === null ? 'reconciler' : 'operator',
        // The role is the database's (verifyResolver), the very field the SQL check at COMMIT reads.
        operator:
          operator === null ? null : { type: operator.type, id: operator.id, role: operator.role },
        osUser: operator?.osUser ?? null,
        otpVerified: operator?.otpVerified ?? null,
        refund:
          refund?.outcome === 'REFUNDED'
            ? { amountTiyin: refund.amountTiyin.toString(), ledgerEntryId: refund.ledgerEntryId }
            : null,
      },
      reason: proof.reason,
      ip: operator?.ip ?? null,
    },
  });
  return {
    to,
    userId: owner.userId,
    refund,
    closedAttemptIds: binding.attemptsToClose.map((a) => a.id),
    securityAlert: binding.securityAlert,
  };
}
