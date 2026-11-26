import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFY_DEDUPE_SEC,
  proofNeedsOwnerOtp,
  totalAfterDiscount,
  type NeedsReviewOutcome,
  type NeedsReviewProof,
  type OrderStatus,
} from '@repo/shared';
import { checkedId, checkedReason, validationError } from '../../../common/admin/admin-input';
import type { OtpAnswer } from '../../../common/admin/owner-otp/owner-otp';
import { OwnerOtpVerifier } from '../../../common/admin/owner-otp/owner-otp.verifier';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { OrderAdminEffects, type EffectsReport } from './order-admin-effects';
import { asRefusal, retryOnDeadlock } from './order-admin-errors';
import { OrderAdminRepository, type OrderDetailRow } from './order-admin.repository';
import {
  OUTSIDE_SYSTEM_FLAG,
  assertBounceRecorded,
  deliversOutsideSystem,
  parseProof,
  resolveOtpTarget,
} from './order-review.input';
import {
  OPERATOR_CHANNEL,
  assertOwnerChannel,
  checkedActor,
  cliResolver,
  type OperatorChannel,
} from './operator-channel';

export interface ResolveRequest {
  readonly orderId: string;
  readonly to: NeedsReviewOutcome;
  /** The parsed JSON the owner typed; validated here and again by @repo/db. */
  readonly proof: unknown;
  readonly reason: string;
}

export interface ResolveInput extends ResolveRequest {
  readonly operator: string;
  readonly ip?: string | null;
  readonly osUser?: string | null;
  /** I-8: the owner said they delivered outside the system (`--delivered-outside-system`). */
  readonly confirmOutsideSystem: boolean;
  readonly confirmAmountTiyin?: bigint;
  readonly otp?: OtpAnswer;
}

/** What the CLI shows and asks before the decision (read without locks; checked again later). */
export interface ResolvePreview {
  readonly orderId: string;
  readonly number: number;
  readonly status: OrderStatus;
  readonly totalTiyin: bigint;
  readonly proof: NeedsReviewProof;
  /** The owner's code is needed: an owner proof (D-59) or a total above the threshold (D-46). */
  readonly needsOtp: boolean;
  readonly otpTarget: string;
  readonly otpFlags: string;
  readonly outsideSystem: boolean;
}

export interface ResolveOutcome {
  /** False: an earlier run already resolved the order this way; nothing was written now. */
  readonly applied: boolean;
  readonly orderId: string;
  readonly to: NeedsReviewOutcome;
  readonly auditId: string;
  readonly refundTiyin: bigint | null;
  readonly refundEntryId: string | null;
  /**
   * null: a replay of a resolution older than EFFECTS_REPLAY_MAX_AGE_MS, whose jobs may have left
   * the dedupe window: nothing was queued again, so nobody hears it twice (CR i1, audit L-5).
   */
  readonly effects: EffectsReport | null;
}

const DAY_MS = 86_400_000;

/**
 * A replay queues the effects again (same stable job ids) only while the first jobs are surely
 * still remembered by BullMQ (NOTIFY_DEDUPE_SEC), with a day of margin for clock skew and slow
 * runs. Past it the effects were sent long ago; queuing them again would send them twice.
 */
export const EFFECTS_REPLAY_MAX_AGE_MS = NOTIFY_DEDUPE_SEC * 1000 - DAY_MS;

/**
 * I-8: `--delivered-outside-system` is given exactly when the order is delivered outside the
 * system. Missing: OUTSIDE_SYSTEM_CONFIRMATION_REQUIRED. Given where it does not apply: refused
 * (OUTSIDE_SYSTEM_NOT_APPLICABLE, re-review N4), not ignored, so the audit row never says "outside
 * the system" for an order whose TON did leave, and the owner hears that the system disagrees.
 */
function assertOutsideSystemFlag(outside: boolean, confirmed: boolean): void {
  if (outside && !confirmed) {
    throw validationError('confirmOutsideSystem', 'OUTSIDE_SYSTEM_CONFIRMATION_REQUIRED');
  }
  if (!outside && confirmed) {
    throw validationError('confirmOutsideSystem', 'OUTSIDE_SYSTEM_NOT_APPLICABLE');
  }
}

/**
 * `order:resolve` (phase 5 S10, plan Q8): the owner moves a NEEDS_REVIEW order to DELIVERED or to
 * FAILED + REFUND with a proof. Not reachable over HTTP: the service needs the CLI channel (I-4).
 * The money and the state change are ONE transaction inside `resolveNeedsReview` (@repo/db):
 * attempts closed, NEEDS_REVIEW -> DELIVERED|FAILED (CAS), the REFUND entry (`ORDER/<orderId>`)
 * and the AuditLog with the proof, the operator, the OS user, the SSH address and `otpVerified`.
 * Lock order wallet -> order -> attempt -> transfer; a deadlock (40P01) is retried as a whole.
 * The owner's code is checked before the transaction (D-46). A re-run after the order already
 * left NEEDS_REVIEW the same way writes nothing and queues the effects again (`applied: false`).
 */
@Injectable()
export class OrderReviewService {
  constructor(
    private readonly repo: OrderAdminRepository,
    private readonly otp: OwnerOtpVerifier,
    private readonly effects: OrderAdminEffects,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OPERATOR_CHANNEL) private readonly channel: OperatorChannel,
  ) {}

  async preview(request: ResolveRequest): Promise<ResolvePreview> {
    assertOwnerChannel(this.channel);
    const orderId = checkedId('orderId', request.orderId);
    const proof = parseProof(request.proof, checkedReason(request.reason), request.to);
    const order = await this.repo.detail(orderId);
    if (order === null) throw new AppError('NOT_FOUND');
    return this.previewOf(order, request.to, proof);
  }

  async resolve(input: ResolveInput): Promise<ResolveOutcome> {
    const actor = checkedActor(input);
    const p = await this.preview(input);
    if (p.status !== 'NEEDS_REVIEW') return this.replay(p, input.to);
    assertOutsideSystemFlag(p.outsideSystem, input.confirmOutsideSystem);
    const otpVerified = await this.otp.verifyIfGiven(
      input.otp,
      input.confirmAmountTiyin,
      'order:resolve',
      p.otpTarget,
      p.otpFlags,
    );
    if (p.needsOtp) {
      if (input.confirmAmountTiyin !== p.totalTiyin) throw validationError('confirmAmountTiyin');
      if (!otpVerified) throw validationError('otp', 'OTP_REQUIRED');
    }
    const resolver = cliResolver(this.channel, actor, otpVerified);
    let committed;
    try {
      committed = await retryOnDeadlock(() =>
        this.repo.transaction(async (tx) => {
          const done = await this.repo.resolve(tx, {
            orderId: p.orderId,
            to: input.to,
            proof: p.proof,
            resolver,
            // Audit L-4: the owner's "delivered outside the system" is kept in the audit row.
            ...(input.confirmOutsideSystem && input.to === 'DELIVERED' && p.proof.kind === 'MANUAL'
              ? { acknowledgements: ['DELIVERED_OUTSIDE_SYSTEM'] as const }
              : {}),
          });
          // I-8 again, under the locks resolveNeedsReview holds: the attempts it just closed.
          const outside =
            input.to === 'DELIVERED' &&
            p.proof.kind === 'MANUAL' &&
            (await this.repo.notSentTransfers(tx, done.result.closedAttemptIds)) > 0;
          // A mismatch rolls back the acknowledgement written above (re-review N4).
          assertOutsideSystemFlag(outside, input.confirmOutsideSystem);
          return done;
        }),
      );
    } catch (error) {
      // Lost a race: another run (or the reconciler) resolved it first. Same way -> replay.
      const refusal = asRefusal(error);
      if (refusal instanceof AppError && refusal.details?.['reason'] === 'STATE_CHANGED') {
        const now = await this.repo.detail(p.orderId);
        if (now !== null && now.status !== 'NEEDS_REVIEW') {
          return this.replay({ ...p, status: now.status }, input.to);
        }
      }
      throw refusal;
    }
    const { result, auditId } = committed;
    const refund = result.refund?.outcome === 'REFUNDED' ? result.refund : null;
    const effects = await this.effects.afterResolve({
      orderId: p.orderId,
      userId: result.userId,
      to: result.to,
      refunded: refund !== null,
      auditId,
      compromisedTransferId:
        result.securityAlert === 'tonWalletCompromised' && p.proof.kind === 'TON_UNMATCHED_RESOLVED'
          ? p.proof.transferId
          : null,
    });
    return {
      applied: true,
      orderId: p.orderId,
      to: result.to,
      auditId,
      refundTiyin: refund?.amountTiyin ?? null,
      refundEntryId: refund?.ledgerEntryId ?? null,
      effects,
    };
  }

  private previewOf(
    order: OrderDetailRow,
    to: NeedsReviewOutcome,
    proof: NeedsReviewProof,
  ): ResolvePreview {
    const totalTiyin = totalAfterDiscount(order.priceTiyin, order.discountTiyin);
    assertBounceRecorded(proof, order.attempts);
    const outsideSystem = deliversOutsideSystem(to, proof, order.attempts);
    return {
      orderId: order.id,
      number: order.number,
      status: order.status,
      totalTiyin,
      proof,
      needsOtp: proofNeedsOwnerOtp(proof) || totalTiyin > this.config.ADMIN_CONFIRM_THRESHOLD_TIYIN,
      otpTarget: resolveOtpTarget(order.id, to, proof),
      otpFlags: outsideSystem ? OUTSIDE_SYSTEM_FLAG : '',
      outsideSystem,
    };
  }

  /**
   * The order is no longer in review. Resolved earlier the same way (same exit, same proof kind):
   * nothing is written, the effects are queued again under their stable ids (only inside
   * EFFECTS_REPLAY_MAX_AGE_MS). Otherwise refused.
   */
  private async replay(p: ResolvePreview, to: NeedsReviewOutcome): Promise<ResolveOutcome> {
    const earlier = await this.repo.resolution(p.orderId);
    if (earlier === null || earlier.to !== to || earlier.proofKind !== p.proof.kind) {
      throw validationError('order', 'NOT_IN_REVIEW');
    }
    const outcome = {
      applied: false,
      orderId: p.orderId,
      to,
      auditId: earlier.auditId,
      refundTiyin: null,
      refundEntryId: null,
    } as const;
    if (this.clock.now().getTime() - earlier.auditAt.getTime() > EFFECTS_REPLAY_MAX_AGE_MS) {
      return { ...outcome, effects: null };
    }
    const order = await this.repo.detail(p.orderId);
    // Not found (it should exist): null, so no `wallet:` key is deleted for an empty id (L-4).
    const userId = order?.userId ?? null;
    const refunded = to === 'FAILED';
    const effects = await this.effects.afterResolve({
      orderId: p.orderId,
      userId,
      to,
      refunded,
      auditId: earlier.auditId,
      compromisedTransferId: earlier.compromisedTransferId,
    });
    return { ...outcome, effects };
  }
}
