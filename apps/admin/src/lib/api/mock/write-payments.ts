// P2P writes of the dev mock (docs/04 «To‘lovlar (P2P)», OWNER): review credit and its preview,
// payment reverse; the card writes are in write-cards.ts.
import {
  AdminCreditPreviewQuerySchema,
  AdminCreditPreviewResponseSchema,
  AdminPaymentReverseBodySchema,
  AdminPaymentReverseResponseSchema,
  AdminReviewCreditBodySchema,
  AdminReviewCreditResponseSchema,
} from '@repo/shared';
import { mid } from './data-common';
import { INTENTS, bankMessageFixture } from './fixtures-payments';
import { USERS } from './fixtures-users';
import { codeNeeded } from './mock-step-up';
import { paymentsView, reviewsView } from './mock-views';
import { fail, ok, type MockRoute } from './router';
import { cardRoutes } from './write-cards';
import { checkCode, fieldError, writeRoute } from './write-kit';

type Target = { userId?: string | undefined; intentId?: string | undefined };

/** Who the money goes to, or null when the target does not exist (a 404 like the API's). */
function creditUser(target: Target): string | null {
  if (target.intentId !== undefined) {
    return INTENTS.find((intent) => intent.id === target.intentId)?.userId ?? null;
  }
  return USERS.find((user) => user.id === target.userId)?.id ?? null;
}

function creditPreview(reviewId: string, target: Target) {
  const review = reviewsView().find((row) => row.id === reviewId);
  if (review === undefined) return { ok: false, reply: fail('NOT_FOUND') } as const;
  if (review.status !== 'OPEN')
    return { ok: false, reply: fieldError('reviewStatus', 'RESOLVED') } as const;
  const message = bankMessageFixture(review.bankMessageId, 'OWNER');
  if (message.parseStatus !== 'PARSED' || message.amountTiyin === null) {
    return { ok: false, reply: fieldError('review', 'NOT_A_PARSED_CREDIT') } as const;
  }
  const userId = creditUser(target);
  if (userId === null) return { ok: false, reply: fail('NOT_FOUND') } as const;
  const user = USERS.find((one) => one.id === userId);
  const blocked = user?.isBlocked ?? false;
  return {
    ok: true,
    preview: AdminCreditPreviewResponseSchema.parse({
      amountTiyin: message.amountTiyin,
      userId,
      blocked,
      purchaseFrozen: user?.purchaseFrozen ?? false,
      accountAgeDays: 412,
      overLimit: false,
      overrideNeeded: blocked ? 'USER_BLOCKED' : null,
      // The CANCELLED_LATE review's message failed the integrity check in this mock.
      needsBankVerification: review.kind === 'CANCELLED_LATE',
      manualCreditsSinceRequest: {
        adjust: { count: 0, sumTiyin: '0' },
        reviewCredit: { count: 0, sumTiyin: '0' },
        since: review.createdAt,
      },
    }),
  } as const;
}

const reviewCredit = writeRoute({
  pattern: '/admin/payments/reviews/:id/credit',
  permission: 'payments.reviewCredit',
  body: AdminReviewCreditBodySchema,
  response: AdminReviewCreditResponseSchema,
  run: (context) => {
    const { params, body, journal, audit, auditId } = context;
    const reviewId = params.id ?? '';
    const result = creditPreview(reviewId, body);
    if (!result.ok) return result.reply;
    const { preview } = result;
    if (preview.overrideNeeded !== null && !body.confirmOverride) {
      return fieldError('user', preview.overrideNeeded);
    }
    if (preview.needsBankVerification && !body.bankVerified) {
      return fieldError('review', 'BANK_VERIFICATION_REQUIRED');
    }
    const target =
      body.intentId === undefined ? { userId: body.userId } : { intentId: body.intentId };
    const refused = checkCode(context, {
      required: true,
      confirmation: {
        action: 'payments.reviewCredit',
        targetId: reviewId,
        amountTiyin: body.confirmAmountTiyin ?? preview.amountTiyin,
        ...target,
        confirmOverride: body.confirmOverride,
        bankVerified: body.bankVerified,
      },
      amountTiyin: preview.amountTiyin,
    });
    if (refused !== null) return refused;
    journal.reviews[reviewId] = { resolution: 'CREDITED_USER' };
    audit({
      action: 'REVIEW_CREDIT',
      targetType: 'PaymentReview',
      targetId: reviewId,
      reason: body.reason,
    });
    return ok({
      reviewId,
      paymentId: mid('pay', 900),
      userId: preview.userId,
      intentId: body.intentId ?? null,
      amountTiyin: preview.amountTiyin,
      auditId,
      applied: true,
    });
  },
});

const reverse = writeRoute({
  pattern: '/admin/payments/:id/reverse',
  permission: 'payments.reverse',
  body: AdminPaymentReverseBodySchema,
  response: AdminPaymentReverseResponseSchema,
  run: (context) => {
    const { params, body, journal, audit, auditId } = context;
    const payment = paymentsView().find((row) => row.id === params.id);
    if (payment === undefined) return fail('NOT_FOUND');
    if (payment.status !== 'CONFIRMED') return fieldError('paymentStatus', 'ALREADY_REVERSED');
    const confirmation = {
      action: 'payments.reverse' as const,
      targetId: payment.id,
      amountTiyin: body.confirmAmountTiyin ?? payment.amountTiyin,
    };
    const refused = checkCode(context, {
      required: codeNeeded(confirmation),
      confirmation,
      amountTiyin: payment.amountTiyin,
    });
    if (refused !== null) return refused;
    journal.payments[payment.id] = { status: 'CANCELLED' };
    audit({
      action: 'PAYMENT_REVERSE',
      targetType: 'Payment',
      targetId: payment.id,
      reason: body.reason,
    });
    // The big top-up was spent in this mock: the balance goes negative and purchases freeze.
    const spent = BigInt(payment.amountTiyin) > 50_000_000n;
    return ok({
      paymentId: payment.id,
      userId: payment.userId,
      ledgerEntryId: mid('led', 901),
      balanceTiyin: spent ? '-12000000' : '0',
      frozen: spent,
      auditId,
      applied: true,
    });
  },
});

export const paymentWriteRoutes: readonly MockRoute[] = [
  reviewCredit,
  reverse,
  {
    method: 'GET',
    pattern: '/admin/payments/reviews/:id/credit-preview',
    permission: 'payments.creditPreview',
    handler: ({ params, query }) => {
      const parsed = AdminCreditPreviewQuerySchema.safeParse(Object.fromEntries(query));
      if (!parsed.success) return fieldError('target');
      const result = creditPreview(params.id ?? '', parsed.data);
      return result.ok ? ok(result.preview) : result.reply;
    },
  },
  ...cardRoutes,
];
