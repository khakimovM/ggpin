import { AppError } from '../../../common/exceptions/app-error';
import { ownerCode } from '../../../common/admin/owner-otp/__tests__/owner-otp.testing';
import { creditOtpTarget } from '../review-credit.checks';
import { ACTOR, HOUR, useOpsE2e } from '../../../cli/__tests__/ops-e2e.harness';
import { ReviewCreditPreviewService } from '../review-credit-preview.service';
import { ReviewCreditService, type CreditReviewInput } from '../review-credit.service';

const t = useOpsE2e();
const service = () => t.app().get(ReviewCreditService);

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

const credit = (reviewId: string, target: CreditReviewInput['target'], extra = {}) =>
  service().credit({
    reviewId,
    target,
    reason: 'owner checked the bank app',
    actor: ACTOR,
    ...extra,
  });

/** A NO_MATCH review of a received ~50 000 so'm on its own card. */
async function openReview(kind: 'NO_MATCH' | 'CANCELLED_LATE' = 'NO_MATCH', amountTiyin?: bigint) {
  const card = await t.card();
  const message = await t.message({ card, ...(amountTiyin === undefined ? {} : { amountTiyin }) });
  const reviewId = await t.review(message.id, kind, { cardId: card.id });
  return { card, message, reviewId };
}

async function moneyOf(bankMessageId: string) {
  const payments = await t.db().payment.findMany({ where: { bankMessageId } });
  const topups = await t.db().ledgerEntry.findMany({
    where: { refType: 'PAYMENT', refId: { in: payments.map((p) => p.id) }, kind: 'TOPUP' },
  });
  return { payments, topups };
}

describe('review:credit (owner CLI, real Postgres)', () => {
  it('--user: Payment + TOPUP + review RESOLVED + AuditLog in one go; cache dropped, user and owner told', async () => {
    const userId = await t.user();
    const { message, reviewId } = await openReview();
    await t.cachedBalance(userId, 'stale');
    const done = await credit(reviewId, { userId });
    expect(done).toMatchObject({ userId, intentId: null, amountTiyin: message.amountTiyin });

    const { payments, topups } = await moneyOf(message.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      id: done.paymentId,
      reviewId,
      userId,
      intentId: null,
      status: 'CONFIRMED',
      amountTiyin: message.amountTiyin,
      providerTxnId: `${message.senderId.toString()}:${message.tgMessageId.toString()}`,
    });
    expect(topups).toHaveLength(1);
    expect(topups[0]).toMatchObject({ userId, amountTiyin: message.amountTiyin });

    const review = await t.db().paymentReview.findUniqueOrThrow({ where: { id: reviewId } });
    expect(review).toMatchObject({
      status: 'RESOLVED',
      resolution: 'CREDITED_USER',
      resolvedAuditLogId: done.auditId,
    });
    const audit = await t.audit(done.auditId);
    expect(audit).toMatchObject({
      actorType: 'CLI',
      actorId: null,
      action: 'REVIEW_CREDIT',
      targetType: 'PaymentReview',
      targetId: reviewId,
      reason: 'owner checked the bank app',
      ip: ACTOR.ip,
    });
    expect(audit.after).toMatchObject({ operator: ACTOR.operator, paymentId: done.paymentId });

    expect(await t.cachedBalance(userId, null)).toBeNull();
    expect(done.notified).toBe(true);
    expect((await t.notifyJob(`topup-${done.paymentId}`))?.data).toEqual({
      kind: 'TOPUP_CREDITED',
      refId: done.paymentId,
    });
    expect(await t.notifyJob(`alert-adminAction-${done.auditId}`)).toBeDefined();
  });

  it('--intent inside the grace window: a CANCELLED request becomes PAID (actor admin), paidAt = arrival', async () => {
    const userId = await t.user();
    const card = await t.card();
    const message = await t.message({ card });
    const intentId = await t.intent(userId, {
      cardId: card.id,
      amountTiyin: message.amountTiyin ?? 0n,
      status: 'CANCELLED',
    });
    const reviewId = await t.review(message.id, 'CANCELLED_LATE', { cardId: card.id, intentId });
    const done = await credit(reviewId, { intentId });
    expect(done).toMatchObject({ userId, intentId });
    const intent = await t.db().paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe('PAID');
    expect(intent.paidAt).toEqual(message.tgDate);
    expect((await moneyOf(message.id)).payments[0]?.intentId).toBe(intentId);
  });

  it('--intent after the grace window is refused (no intent changes then); --user still credits', async () => {
    const userId = await t.user();
    const card = await t.card();
    const message = await t.message({ card });
    const intentId = await t.intent(userId, {
      cardId: card.id,
      amountTiyin: message.amountTiyin ?? 0n,
      status: 'EXPIRED',
      createdAt: new Date(Date.now() - 3 * 24 * HOUR),
    });
    const reviewId = await t.review(message.id, 'NO_MATCH', { cardId: card.id });
    const refused = await refusal(credit(reviewId, { intentId }));
    expect(refused.details).toEqual({ field: 'intentId', reason: 'GRACE_ELAPSED' });
    expect((await moneyOf(message.id)).payments).toHaveLength(0);
    await credit(reviewId, { userId });
    expect((await t.db().paymentIntent.findUniqueOrThrow({ where: { id: intentId } })).status).toBe(
      'EXPIRED',
    );
  });

  it('--intent of another card or another amount is refused (MISMATCH), nothing written', async () => {
    const userId = await t.user();
    const { message, reviewId } = await openReview();
    const other = await t.card();
    const intentId = await t.intent(userId, {
      cardId: other.id,
      amountTiyin: message.amountTiyin ?? 0n,
      status: 'PENDING',
    });
    expect((await refusal(credit(reviewId, { intentId }))).details).toEqual({
      field: 'intentId',
      reason: 'MISMATCH',
    });
    expect((await moneyOf(message.id)).payments).toHaveLength(0);
    expect((await t.db().paymentReview.findUniqueOrThrow({ where: { id: reviewId } })).status).toBe(
      'OPEN',
    );
  });

  it('a second credit of the same review is refused: one Payment, one TOPUP', async () => {
    const userId = await t.user();
    const { message, reviewId } = await openReview();
    await credit(reviewId, { userId });
    const again = await refusal(credit(reviewId, { userId }));
    expect(again.details).toEqual({ field: 'reviewStatus', reason: 'RESOLVED' });
    const { payments, topups } = await moneyOf(message.id);
    expect(payments).toHaveLength(1);
    expect(topups).toHaveLength(1);
  });

  it('another review of the same bank message cannot credit it again (Payment.bankMessageId)', async () => {
    const userId = await t.user();
    const { card, message, reviewId } = await openReview();
    const second = await t.review(message.id, 'DUPLICATE', { cardId: card.id });
    await credit(reviewId, { userId });
    const refused = await refusal(credit(second, { userId: await t.user() }));
    expect(refused.details).toEqual({ field: 'bankMessage', reason: 'ALREADY_CREDITED' });
    expect((await moneyOf(message.id)).payments).toHaveLength(1);
  });

  it('two credits of one review at once (two operators): exactly one wins', async () => {
    const [a, b] = [await t.user(), await t.user()];
    const { message, reviewId } = await openReview();
    const results = await Promise.allSettled([
      credit(reviewId, { userId: a }),
      credit(reviewId, { userId: b }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost?.status === 'rejected' && lost.reason instanceof AppError).toBe(true);
    const { payments, topups } = await moneyOf(message.id);
    expect(payments).toHaveLength(1);
    expect(topups).toHaveLength(1);
  });

  it('a card-less message credited through two reviews at once: one payment (the unique key decides)', async () => {
    const message = await t.message({ card: null });
    const r1 = await t.review(message.id, 'CARD_UNKNOWN');
    const r2 = await t.review(message.id, 'DUPLICATE');
    const results = await Promise.allSettled([
      credit(r1, { userId: await t.user() }),
      credit(r2, { userId: await t.user() }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await moneyOf(message.id)).payments).toHaveLength(1);
  });

  it('refuses an unknown user (NOT_FOUND), a missing reason, a DEBIT or an unparsed message', async () => {
    const { reviewId } = await openReview();
    expect((await refusal(credit(reviewId, { userId: 'cm0000000000000000000000' }))).code).toBe(
      'NOT_FOUND',
    );
    expect(
      (
        await refusal(
          service().credit({
            reviewId,
            target: { userId: await t.user() },
            reason: ' ',
            actor: ACTOR,
          }),
        )
      ).details,
    ).toEqual({ field: 'reason' });
    const card = await t.card();
    const debit = await t.message({ card, direction: 'DEBIT' });
    const debitReview = await t.review(debit.id, 'POSSIBLE_REVERSAL', { cardId: card.id });
    expect((await refusal(credit(debitReview, { userId: await t.user() }))).details).toEqual({
      field: 'review',
      reason: 'NOT_A_PARSED_CREDIT',
    });
    const unparsed = await t.message({ card: null, parsed: false });
    const unparsedReview = await t.review(unparsed.id, 'UNRECOGNIZED');
    expect((await refusal(credit(unparsedReview, { userId: await t.user() }))).details).toEqual({
      field: 'review',
      reason: 'NOT_A_PARSED_CREDIT',
    });
    expect((await t.db().paymentReview.findUniqueOrThrow({ where: { id: reviewId } })).status).toBe(
      'OPEN',
    );
  });

  it('above ADMIN_CONFIRM_THRESHOLD_TIYIN: the exact amount re-typed and a code bound to the flags', async () => {
    // 2 000 000 so'm + a suffix: over the 1 000 000 so'm threshold of the test env.
    const amountTiyin = 200_012_300n;
    expect(amountTiyin > t.env.ADMIN_CONFIRM_THRESHOLD_TIYIN).toBe(true);
    const userId = await t.user();
    const { message, reviewId } = await openReview('NO_MATCH', amountTiyin);
    for (const confirm of [undefined, amountTiyin - 100n]) {
      const refused = await refusal(
        credit(reviewId, { userId }, confirm === undefined ? {} : { confirmAmountTiyin: confirm }),
      );
      expect(refused.details).toEqual({ field: 'confirmAmountTiyin' });
    }
    expect((await moneyOf(message.id)).payments).toHaveLength(0);
    expect(
      (await refusal(credit(reviewId, { userId }, { confirmAmountTiyin: amountTiyin }))).details,
    ).toEqual({ field: 'otp', reason: 'OTP_REQUIRED' });
    // A brand-new account is over its 500 000 so‘m daily cap (D-46 (2)): the override never
    // stands in for the code (R4).
    const typed = { confirmAmountTiyin: amountTiyin };
    const reasonOf = async (extra: Partial<CreditReviewInput>) =>
      (await refusal(credit(reviewId, { userId }, { ...typed, ...extra }))).details;
    expect(await reasonOf({ confirmOverride: true })).toEqual({
      field: 'otp',
      reason: 'OTP_REQUIRED',
    });
    const codeFor = (flags: string) =>
      ownerCode(t.app(), {
        action: 'review:credit',
        amountTiyin,
        target: creditOtpTarget(reviewId, { userId }),
        flags,
      });
    // The code is bound to the flags too (R2): one issued without the override does not carry
    // one, one issued with it does not work without it or with another flag added.
    const mismatch = { field: 'otp', reason: 'OTP_MISMATCH' };
    expect(await reasonOf({ otp: await codeFor(''), confirmOverride: true })).toEqual(mismatch);
    const otp = await codeFor('override: overLimit');
    expect(await reasonOf({ otp })).toEqual(mismatch);
    expect(await reasonOf({ otp, confirmOverride: true, bankVerified: true })).toEqual(mismatch);
    // The state under the wallet lock is not the one the code was issued for: refused there.
    const previews = t.app().get(ReviewCreditPreviewService);
    const real = await previews.preview(reviewId, { userId });
    const stale = jest
      .spyOn(previews, 'preview')
      .mockResolvedValueOnce({ ...real, user: { ...real.user, overLimit: false } });
    try {
      const staleCode = await codeFor('override: none');
      expect(await reasonOf({ otp: staleCode, confirmOverride: true })).toEqual(mismatch);
    } finally {
      stale.mockRestore();
    }
    expect((await moneyOf(message.id)).payments).toHaveLength(0);
    await credit(reviewId, { userId }, { ...typed, otp, confirmOverride: true });
    expect((await moneyOf(message.id)).topups[0]?.amountTiyin).toBe(amountTiyin);
  }, 30_000);
});
