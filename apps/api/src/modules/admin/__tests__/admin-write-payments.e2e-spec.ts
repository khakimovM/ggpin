import { randomUUID } from 'node:crypto';
import { manualCreditsSince } from '@repo/db';
import {
  AdminCardChangeResponseSchema,
  AdminPaymentReverseResponseSchema,
  AdminReviewCreditResponseSchema,
  SECURITY_PAUSE_AUDIT,
} from '@repo/shared';
import { useAdminE2e } from './admin-e2e.harness';
import { adminWriteKit, dataOf, errorOf } from './admin-write.e2e-kit';

// Phase 9 S6: `/admin/payments/*` writes — P2P review credit, top-up reversal and the card
// actions (docs/04 «To‘lovlar», D-63 (3), D-65 D1/D3), OWNER only.
const t = useAdminE2e();
const kit = adminWriteKit(t);
const REASON = 'owner checked the bank app';

describe('admin payment actions (S6)', () => {
  it('review credit: always a code; Payment + TOPUP + ADMIN audit; replay; manualCreditsSince counts it', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const { reviewId, amountTiyin } = await kit.review();
    const amount = amountTiyin.toString();
    const since = new Date(Date.now() - 60_000);
    const key = randomUUID();
    const base = { userId, reason: REASON, confirmAmountTiyin: amount };
    const bare = await kit.post(owner, `payments/reviews/${reviewId}/credit`, base, key);
    expect(errorOf(bare).details).toEqual([{ path: 'otp', code: 'OTP_REQUIRED' }]);

    const otp = await kit.code(owner, {
      action: 'payments.reviewCredit',
      targetId: reviewId,
      amountTiyin: amount,
      userId,
      confirmOverride: false,
      bankVerified: false,
    });
    const res = await kit.post(owner, `payments/reviews/${reviewId}/credit`, { ...base, otp }, key);
    expect(res.statusCode).toBe(200);
    const done = AdminReviewCreditResponseSchema.parse(dataOf(res));
    expect(done).toMatchObject({ reviewId, userId, amountTiyin: amount, applied: true });
    expect(await kit.balance(userId)).toBe(amountTiyin);
    const audit = await t.db().auditLog.findUniqueOrThrow({ where: { id: done.auditId } });
    expect(audit).toMatchObject({ actorType: 'ADMIN', actorId: owner.admin.id });
    expect(audit.after).toMatchObject({ adminRole: 'OWNER' });
    const review = await t.db().paymentReview.findUniqueOrThrow({ where: { id: reviewId } });
    expect(review.status).toBe('RESOLVED');
    expect(await kit.alerts('adminAction', done.auditId)).toBe(1);

    const again = await kit.post(owner, `payments/reviews/${reviewId}/credit`, base, key);
    expect(dataOf(again)).toMatchObject({ paymentId: done.paymentId, applied: false });
    expect(await kit.balance(userId)).toBe(amountTiyin);
    const manual = await manualCreditsSince(t.db(), userId, since);
    expect(manual.reviewCredit).toEqual({ count: 1, sumTiyin: amountTiyin });
  });

  it('reverse: at or below the threshold no code; above it OTP_REQUIRED then a code; OPERATOR 404', async () => {
    const owner = await kit.session('OWNER');
    const operator = await kit.session('OPERATOR');
    const userId = await kit.user();
    const small = await kit.payment(userId, 300_000n);
    expect(
      (await kit.post(operator, `payments/${small}/reverse`, { reason: REASON })).statusCode,
    ).toBe(404);
    const res = await kit.post(owner, `payments/${small}/reverse`, { reason: REASON });
    const done = AdminPaymentReverseResponseSchema.parse(dataOf(res));
    expect(done).toMatchObject({ paymentId: small, userId, balanceTiyin: '0', applied: true });
    const entry = await t.db().ledgerEntry.findUniqueOrThrow({ where: { id: done.ledgerEntryId } });
    expect(entry).toMatchObject({ kind: 'TOPUP_REVERSAL', amountTiyin: -300_000n });

    const threshold = t.env.ADMIN_CONFIRM_THRESHOLD_TIYIN;
    const bigAmount = threshold + 100n;
    const big = await kit.payment(userId, bigAmount);
    const key = randomUUID();
    const bare = await kit.post(owner, `payments/${big}/reverse`, { reason: REASON }, key);
    expect(errorOf(bare).details).toEqual([{ path: 'otp', code: 'OTP_REQUIRED' }]);
    const otp = await kit.code(owner, {
      action: 'payments.reverse',
      targetId: big,
      amountTiyin: bigAmount.toString(),
    });
    const body = { reason: REASON, confirmAmountTiyin: bigAmount.toString(), otp };
    const ok = await kit.post(owner, `payments/${big}/reverse`, body, key);
    expect(dataOf(ok)).toMatchObject({ paymentId: big, applied: true, frozen: false });
    expect(await kit.balance(userId)).toBe(0n);
  });

  it('cards: pause, limit, emergency retire; a SECURITY pause is lifted only with the code', async () => {
    const owner = await kit.session('OWNER');
    const card = await kit.card();
    const pause = await kit.post(owner, `payments/cards/${card.id}/pause`, { reason: REASON });
    const paused = AdminCardChangeResponseSchema.parse(dataOf(pause));
    expect(paused).toMatchObject({ applied: true, cancelledIntents: 0 });
    expect(paused.card.autoCreditPaused).toBe(true);
    const row = await t.db().auditLog.findUniqueOrThrow({ where: { id: paused.auditId ?? '' } });
    expect(row).toMatchObject({
      actorType: 'ADMIN',
      actorId: owner.admin.id,
      action: 'CARD_PAUSE',
    });

    await t.db().auditLog.create({
      data: {
        ...SECURITY_PAUSE_AUDIT,
        actorId: null,
        ip: null,
        targetId: card.id,
        reason: 'NEW_AUTHORIZATION',
        after: { autoCreditPaused: true, reason: 'NEW_AUTHORIZATION', ref: 'e2e-s6' },
      },
    });
    const resumeBody = { reason: REASON, confirmSecurityPause: true };
    const key = randomUUID();
    const bare = await kit.post(owner, `payments/cards/${card.id}/resume`, resumeBody, key);
    expect(errorOf(bare).details).toEqual([{ path: 'otp', code: 'OTP_REQUIRED' }]);
    const otp = await kit.code(owner, {
      action: 'cards.resume',
      targetId: card.id,
      confirmOverride: false,
      confirmSecurityPause: true,
    });
    const resumed = await kit.post(
      owner,
      `payments/cards/${card.id}/resume`,
      { ...resumeBody, otp },
      key,
    );
    expect(resumed.statusCode).toBe(200);
    const lifted = AdminCardChangeResponseSchema.parse(dataOf(resumed));
    expect(lifted.card.autoCreditPaused).toBe(false);
    const liftRow = await t
      .db()
      .auditLog.findUniqueOrThrow({ where: { id: lifted.auditId ?? '' } });
    expect(liftRow.after).toMatchObject({ otpVerified: true });

    // Lowering the limit and any retire ask the code (owner decision 2026-11-18, SA-S6-3).
    const limitBody = { receiveLimitTiyin: '500000000', monthlyLimitTiyin: null, reason: REASON };
    const limitKey = randomUUID();
    const bareLimit = await kit.post(owner, `payments/cards/${card.id}/limit`, limitBody, limitKey);
    expect(errorOf(bareLimit).details).toEqual([{ path: 'otp', code: 'OTP_REQUIRED' }]);
    const limitOtp = await kit.code(owner, {
      action: 'cards.limit',
      targetId: card.id,
      receiveLimitTiyin: '500000000',
      monthlyLimitTiyin: null,
    });
    const limit = await kit.post(
      owner,
      `payments/cards/${card.id}/limit`,
      { ...limitBody, otp: limitOtp },
      limitKey,
    );
    expect(dataOf(limit)).toMatchObject({
      applied: true,
      card: { receiveLimitTiyin: '500000000' },
    });
    const retireBody = { reason: REASON, emergency: true };
    const retireKey = randomUUID();
    const bareRetire = await kit.post(
      owner,
      `payments/cards/${card.id}/retire`,
      retireBody,
      retireKey,
    );
    expect(errorOf(bareRetire).details).toEqual([{ path: 'otp', code: 'OTP_REQUIRED' }]);
    expect((await t.db().topupCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'ACTIVE',
    );
    const retireOtp = await kit.code(owner, {
      action: 'cards.retire',
      targetId: card.id,
      emergency: true,
    });
    const retire = await kit.post(
      owner,
      `payments/cards/${card.id}/retire`,
      { ...retireBody, otp: retireOtp },
      retireKey,
    );
    expect(dataOf(retire)).toMatchObject({ applied: true, card: { status: 'RETIRED' } });
    const retireRow = await t
      .db()
      .auditLog.findUniqueOrThrow({ where: { id: dataOf<{ auditId: string }>(retire).auditId } });
    expect(retireRow.after).toMatchObject({ otpVerified: true });
    // SA-S6-12: the sign-in that did it.
    expect(typeof (retireRow.after as { sessionId?: unknown }).sessionId).toBe('string');
  });

  it('cards: a plain resume needs no code, and the code route says OTP_NOT_REQUIRED', async () => {
    const owner = await kit.session('OWNER');
    const card = await kit.card();
    await kit.post(owner, `payments/cards/${card.id}/pause`, { reason: REASON });
    const ask = await kit.post(
      owner,
      'confirmations',
      {
        action: 'cards.resume',
        targetId: card.id,
        confirmOverride: false,
        confirmSecurityPause: false,
      },
      null,
    );
    expect(errorOf(ask).details).toEqual([{ path: 'action', code: 'OTP_NOT_REQUIRED' }]);
    const resumed = await kit.post(owner, `payments/cards/${card.id}/resume`, { reason: REASON });
    expect(dataOf(resumed)).toMatchObject({ applied: true, card: { autoCreditPaused: false } });
  });
});
