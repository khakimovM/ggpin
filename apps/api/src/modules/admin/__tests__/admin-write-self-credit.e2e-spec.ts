import { randomBytes, randomUUID } from 'node:crypto';
import type { AdminUser } from '@repo/db';
import type { AdminActor } from '../../../common/admin/audit-actor';
import { AppError } from '../../../common/exceptions/app-error';
import { ReviewCreditService } from '../../payments/review-credit.service';
import { adminAuditIdFor } from '../write/admin-write-key';
import { useAdminE2e } from './admin-e2e.harness';
import { adminWriteKit } from './admin-write.e2e-kit';

// Phase 9 S6 re-review (N-2): the action side of SA-S6-9 in review:credit. Through HTTP the code's
// binding (the whole body) and the confirmation's own SELF_TARGET check stop a credit to the
// admin's account first, so the in-transaction check is proven here on the service, with an admin
// actor whose step-up code is taken as verified (as if a code for another user had been reused):
// the money still never reaches the admin's own wallet, by userId or through its own intent.
const t = useAdminE2e();
const kit = adminWriteKit(t);
const REASON = 'owner checked the bank app';
const SELF_TARGET = { field: 'userId', reason: 'SELF_TARGET' };
const GRACE_MS = 24 * 60 * 60_000;

/** The admin's own store account (same Telegram id); the harness removes it with the admin. */
async function storeAccountOf(admin: AdminUser): Promise<string> {
  const row = await t.db().user.create({
    data: {
      telegramId: admin.telegramId,
      firstName: 'Admin store account',
      referralCode: `adm${randomBytes(6).toString('hex')}`,
      wallet: { create: {} },
    },
    select: { id: true },
  });
  return row.id;
}

/** The panel actor of a signed-in admin, its code already checked (verify always passes). */
async function panelActor(admin: AdminUser): Promise<AdminActor> {
  const session = await t.db().adminSession.findFirstOrThrow({
    where: { adminId: admin.id, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  return {
    kind: 'ADMIN',
    adminId: admin.id,
    sessionId: session.id,
    ip: null,
    permission: 'payments.reviewCredit',
    request: { auditId: adminAuditIdFor(admin.id, randomUUID()), requestHash: 'n2-self-target' },
    stepUp: { verify: () => Promise.resolve() },
  };
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

/** Nothing of the credit was written: no payment for the message, the review still open. */
async function nothingWritten(reviewId: string, messageId: string, ownUser: string) {
  expect(await t.db().payment.count({ where: { bankMessageId: messageId } })).toBe(0);
  const review = await t.db().paymentReview.findUniqueOrThrow({ where: { id: reviewId } });
  expect(review.status).toBe('OPEN');
  expect(await t.db().ledgerEntry.count({ where: { userId: ownUser } })).toBe(0);
  expect(await t.db().auditLog.count({ where: { targetId: reviewId } })).toBe(0);
}

describe('review:credit to the admin own account (N-2, SA-S6-9 action side)', () => {
  it('a verified credit to the own userId is SELF_TARGET; to another user it passes', async () => {
    const owner = await kit.session('OWNER');
    const own = await storeAccountOf(owner.admin);
    const credits = t.app().get(ReviewCreditService);
    const { reviewId, amountTiyin, messageId } = await kit.review();
    const input = (userId: string, actor: AdminActor) => ({
      reviewId,
      target: { userId },
      reason: REASON,
      actor,
      confirmAmountTiyin: amountTiyin,
    });

    const refused = await refusal(credits.credit(input(own, await panelActor(owner.admin))));
    expect(refused.details).toEqual(SELF_TARGET);
    await nothingWritten(reviewId, messageId, own);

    // The same verified actor shape credits another user: only the target made it refuse.
    const other = await kit.user();
    const done = await credits.credit(input(other, await panelActor(owner.admin)));
    expect(done).toMatchObject({ userId: other, amountTiyin });
    expect(await kit.balance(other)).toBe(amountTiyin);
  });

  it('a verified credit through an intent the admin own account made is SELF_TARGET, the intent untouched', async () => {
    const owner = await kit.session('OWNER');
    const own = await storeAccountOf(owner.admin);
    const credits = t.app().get(ReviewCreditService);
    const { reviewId, amountTiyin, messageId } = await kit.review();
    const message = await t.db().bankMessage.findUniqueOrThrow({ where: { id: messageId } });
    const tag = randomBytes(8).toString('hex');
    const expiresAt = new Date(Date.now() + 20 * 60_000);
    const intent = await t.db().paymentIntent.create({
      data: {
        userId: own,
        provider: 'P2P_CARD',
        cardId: message.cardId,
        baseAmountTiyin: amountTiyin - (amountTiyin % 100_000n),
        amountTiyin,
        status: 'PENDING',
        purpose: 'TOPUP',
        idempotencyKey: `n2_${tag}`,
        requestHash: `n2_${tag}`,
        createdAt: new Date(Date.now() - 10 * 60_000),
        expiresAt,
        reservedUntil: new Date(expiresAt.getTime() + GRACE_MS),
      },
      select: { id: true },
    });
    try {
      const refused = await refusal(
        credits.credit({
          reviewId,
          target: { intentId: intent.id },
          reason: REASON,
          actor: await panelActor(owner.admin),
          confirmAmountTiyin: amountTiyin,
        }),
      );
      expect(refused.details).toEqual(SELF_TARGET);
      await nothingWritten(reviewId, messageId, own);
      const after = await t.db().paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
      expect(after.status).toBe('PENDING');
    } finally {
      // The intent restricts its user: removed so the harness can remove the store account.
      await t.db().paymentIntent.delete({ where: { id: intent.id } });
    }
  });
});
