import type { NeedsReviewOutcome } from '@repo/shared';
import { OrderReviewService } from '../../modules/orders/admin/order-review.service';
import {
  ACTOR_OPTIONS,
  ACTOR_USAGE,
  UsageError,
  actorOf,
  confirmOwner,
  flag,
  money,
  parse,
  positional,
  report,
  required,
  type CliCommand,
} from './command';

const USAGE =
  `order:resolve <orderId> (--delivered | --failed) --proof <json> ${ACTOR_USAGE} ` +
  '[--delivered-outside-system]\n' +
  '   Only a NEEDS_REVIEW order. --proof is one proof of packages/shared review-proof.ts\n' +
  '   (TON_TX, FRAGMENT_STATUS, MANUAL -> --delivered; TON_NOT_SENT, TON_NOT_DEBITED,\n' +
  '   TON_BOUNCED, TON_UNMATCHED_RESOLVED, MANUAL -> --failed, which refunds the order).\n' +
  '   Its "reason" may be left out: --reason is used. order:show prints the ids and hashes.\n' +
  "   MANUAL and the TON_NOT_DEBITED / TON_BOUNCED / TON_UNMATCHED_RESOLVED proofs need the owner's\n" +
  '   code at any amount; every proof needs it above the confirmation threshold.\n' +
  '   --delivered-outside-system  a MANUAL delivery while the system never saw the TON leave:\n' +
  '                               you delivered outside the system (refused without it)';

function outcomeOf(delivered: boolean, failed: boolean): NeedsReviewOutcome {
  if (delivered === failed) throw new UsageError('give exactly one of --delivered or --failed');
  return delivered ? 'DELIVERED' : 'FAILED';
}

function proofOf(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new UsageError('--proof: not valid JSON');
  }
}

/**
 * order:resolve (phase 5 S10). The service checks the proof's shape and kind and shows what the
 * decision is about before anything is asked; I-8 is warned about; the owner's code is asked when
 * the proof or the amount needs it (D-46, D-59); then ONE transaction resolves (and refunds).
 */
export const ORDER_RESOLVE_COMMAND: CliCommand = {
  name: 'order:resolve',
  summary: 'decide a NEEDS_REVIEW order with a proof: DELIVERED, or FAILED + refund',
  usage: USAGE,
  async run(ctx, argv) {
    const p = parse(
      argv,
      {
        ...ACTOR_OPTIONS,
        delivered: { type: 'boolean' },
        failed: { type: 'boolean' },
        proof: { type: 'string' },
        'delivered-outside-system': { type: 'boolean' },
      },
      1,
    );
    const to = outcomeOf(flag(p, 'delivered'), flag(p, 'failed'));
    const proof = proofOf(required(p, 'proof'));
    const { reason, actor } = actorOf(ctx, p);
    const orderId = positional(p, 0);
    const confirmOutsideSystem = flag(p, 'delivered-outside-system');
    const reviews = ctx.app.get(OrderReviewService);

    const preview = await reviews.preview({ orderId, to, proof, reason });
    report(ctx, {
      order: preview.orderId,
      number: preview.number,
      status: preview.status,
      to,
      proofKind: preview.proof.kind,
      total: money(preview.totalTiyin),
      ownerCode: preview.needsOtp,
    });
    if (preview.outsideSystem) {
      ctx.io.err(
        'warning: TON never left the wallet for this order as far as the system knows. ' +
          'Did you deliver it outside the system?',
      );
      if (!confirmOutsideSystem) {
        ctx.io.err('nothing written: if you did, run again with --delivered-outside-system');
      }
    }
    // Nothing is asked for an order that already left review (a re-run) or a refusal to come: the
    // I-8 flag must be given exactly when it applies (re-review N4).
    const ask = preview.status === 'NEEDS_REVIEW' && preview.outsideSystem === confirmOutsideSystem;
    const confirmation = ask
      ? await confirmOwner(
          ctx,
          {
            action: 'order:resolve',
            amountTiyin: preview.totalTiyin,
            target: preview.otpTarget,
            ...(preview.otpFlags === '' ? {} : { flags: preview.otpFlags }),
          },
          { always: preview.needsOtp },
        )
      : { fields: {}, done: () => Promise.resolve() };
    try {
      const done = await reviews.resolve({
        orderId,
        to,
        proof,
        reason,
        operator: actor.operator,
        ip: actor.ip ?? null,
        osUser: actor.osUser ?? null,
        confirmOutsideSystem,
        ...confirmation.fields,
      });
      const effects = done.effects;
      report(ctx, {
        applied: done.applied,
        resolved: done.to,
        audit: done.auditId,
        refund: done.refundTiyin === null ? null : money(done.refundTiyin),
        refundEntry: done.refundEntryId,
        customerNotified: effects?.customerNotified ?? null,
        alertQueued: effects === null ? null : effects.adminAction && effects.reviewResolved,
        securityAlertQueued: effects?.securityAlert ?? null,
      });
      if (effects === null) {
        ctx.io.err(
          'already resolved long ago: the notices and alerts were sent then and are NOT sent again',
        );
      } else if (effects.securityAlert === false) {
        ctx.io.err(
          'CRITICAL: the tonWalletCompromised alert was NOT queued. Run the same command again ' +
            '(it writes nothing twice) and stop new TON payouts (docs/06 runbook step 4).',
        );
      }
    } finally {
      await confirmation.done();
    }
  },
};
