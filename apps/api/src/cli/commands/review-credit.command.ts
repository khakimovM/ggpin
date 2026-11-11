import { validationError } from '../../common/admin/admin-input';
import {
  creditOtpFlags,
  creditOtpTarget,
  type CreditTarget,
} from '../../modules/payments/review-credit.checks';
import { ReviewCreditService } from '../../modules/payments/review-credit.service';
import {
  ACTOR_OPTIONS,
  ACTOR_USAGE,
  UsageError,
  actorOf,
  confirmIfLarge,
  flag,
  money,
  parse,
  positional,
  report,
  text,
  type CliCommand,
} from './command';

const USAGE =
  `review:credit <reviewId> (--user <userId> | --intent <intentId>) ${ACTOR_USAGE} ` +
  '[--confirm-override] [--bank-verified]\n' +
  '   --confirm-override  credit a blocked user or one over the daily limit anyway (a bare\n' +
  '                       flag, no value; wallet:adjust takes --confirm-override=<set>)\n' +
  '   --bank-verified     the message failed its integrity check (SENDER_MISMATCH or\n' +
  '                       TEXT_HASH_MISMATCH) and you confirmed the transfer in the bank app';

/**
 * review:credit (docs/05 §7, D-46). First the state the decision depends on is shown (the
 * amount, the user: blocked, purchaseFrozen, account age, today's base sum against the limit),
 * then refusals that need a flag happen before anything is asked, then the amount is re-typed
 * and the owner's code asked above the threshold. The service checks everything again under its
 * locks; `--confirm-override` never replaces the code.
 */
export const REVIEW_CREDIT_COMMAND: CliCommand = {
  name: 'review:credit',
  summary: 'credit the money of a reviewed message to a user (or to its request)',
  usage: USAGE,
  async run(ctx, argv) {
    const p = parse(
      argv,
      {
        ...ACTOR_OPTIONS,
        user: { type: 'string' },
        intent: { type: 'string' },
        'confirm-override': { type: 'boolean' },
        'bank-verified': { type: 'boolean' },
      },
      1,
    );
    const user = text(p, 'user');
    const intent = text(p, 'intent');
    if ((user === undefined) === (intent === undefined)) {
      throw new UsageError('give exactly one of --user or --intent');
    }
    const { reason, actor } = actorOf(ctx, p);
    const reviewId = positional(p, 0);
    const target: CreditTarget = user === undefined ? { intentId: intent ?? '' } : { userId: user };
    const override = flag(p, 'confirm-override');
    const bankVerified = flag(p, 'bank-verified');
    const credits = ctx.app.get(ReviewCreditService);

    const preview = await credits.preview(reviewId, target);
    const u = preview.user;
    const hand = preview.manualCreditsSinceRequest;
    const sum = (c: { count: number; sumTiyin: bigint }) =>
      `${String(c.count)} (+${money(c.sumTiyin)})`;
    report(ctx, {
      amount: money(preview.amountTiyin),
      user: preview.userId,
      blocked: u.blocked,
      purchaseFrozen: u.purchaseFrozen,
      accountAgeDays: Math.floor(u.accountAgeSec / 86_400),
      todayBase: `${money(u.usedBaseTiyin)} + ${money(u.requestedBaseTiyin)} of ${money(u.limitTiyin)} (${u.limitReason})`,
      overLimit: u.overLimit,
      // D-47: money already given by hand since the request began (never paid twice); the
      // matcher's MANUAL_CREDIT_SEEN predicate, by kind.
      manualCreditsSinceRequest: `adjust=${sum(hand.adjust)}, reviewCredit=${sum(hand.reviewCredit)} since ${hand.since.toISOString()}`,
    });
    // Refused before any code is sent; the service refuses the same under its locks.
    if (preview.overrideNeeded !== null && !override) {
      ctx.io.err('nothing written: to credit anyway, run again with --confirm-override');
      throw validationError('user', preview.overrideNeeded);
    }
    if (preview.needsBankVerification && !bankVerified) {
      ctx.io.err('confirm the transfer in the bank app, then run again with --bank-verified');
      throw validationError('review', 'BANK_VERIFICATION_REQUIRED');
    }

    // What the owner confirms besides the amount: in the code's message and bound to the code.
    const flags = creditOtpFlags(u, { override, bankVerified });
    report(ctx, { confirms: flags === '' ? '-' : flags });
    const confirmation = await confirmIfLarge(ctx, {
      action: 'review:credit',
      amountTiyin: preview.amountTiyin,
      target: creditOtpTarget(reviewId, target),
      flags,
    });
    try {
      const done = await credits.credit({
        reviewId,
        target,
        reason,
        actor,
        confirmOverride: override,
        bankVerified,
        ...confirmation.fields,
      });
      report(ctx, {
        review: done.reviewId,
        resolution: 'CREDITED_USER',
        payment: done.paymentId,
        user: done.userId,
        intent: done.intentId,
        amount: money(done.amountTiyin),
        audit: done.auditId,
        notified: done.notified,
      });
    } finally {
      await confirmation.done();
    }
  },
};
