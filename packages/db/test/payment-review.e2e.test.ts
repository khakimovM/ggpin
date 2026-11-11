import { describe, expect, it } from 'vitest';
import { expectCheck, expectGuard, expectPrismaCode } from './check-helpers';
import { db } from './client';
import {
  createAuditLog,
  createBankMessage,
  createCard,
  createReview,
  p2pFixture,
  paymentData,
  type ReviewData,
} from './payments-factories';

describe('PaymentReview_resolved_check and PaymentReview_audit_check', () => {
  it('accepts an OPEN review and a fully recorded RESOLVED one', async () => {
    await createReview();
    const audit = await createAuditLog();
    await createReview({
      kind: 'DUPLICATE',
      status: 'RESOLVED',
      resolution: 'IGNORED',
      resolvedAt: new Date(),
      resolvedAuditLogId: audit.id,
    });
  });

  it('RESOLVED holds exactly with a resolution, a time AND an audit row', async () => {
    const audit = await createAuditLog();
    const [resolution, resolvedAt, resolvedAuditLogId] = ['IGNORED' as const, new Date(), audit.id];
    const cases: [Partial<ReviewData>, string][] = [
      // neither the resolution nor the audit row: both CHECKs refuse it, Postgres names one of them
      [{ status: 'RESOLVED' }, 'violates check constraint "PaymentReview_'],
      [{ status: 'RESOLVED', resolution, resolvedAt }, 'PaymentReview_audit_check'],
      [{ status: 'RESOLVED', resolution, resolvedAuditLogId }, 'PaymentReview_resolved_check'],
      [{ status: 'RESOLVED', resolvedAt, resolvedAuditLogId }, 'PaymentReview_resolved_check'],
      [{ resolution, resolvedAt }, 'PaymentReview_resolved_check'], // OPEN with a resolution
      [{ resolution }, 'PaymentReview_resolved_check'],
      [{ resolvedAt }, 'PaymentReview_resolved_check'],
      [{ resolvedAuditLogId }, 'PaymentReview_audit_check'], // OPEN with an audit row
    ];
    for (const [overrides, constraint] of cases) {
      await expectCheck(createReview(overrides), constraint);
    }
  });

  it('the audit row must exist (foreign key)', async () => {
    await expectPrismaCode(
      createReview({
        status: 'RESOLVED',
        resolution: 'IGNORED',
        resolvedAt: new Date(),
        resolvedAuditLogId: 'no-such-audit-row',
      }),
      'P2003',
    );
  });
});

describe('PaymentReview message link and idempotency', () => {
  it('(bankMessageId, kind): one review of a kind per message, other kinds are fine', async () => {
    const message = await createBankMessage();
    await createReview({ bankMessageId: message.id, kind: 'NO_MATCH' });
    await createReview({ bankMessageId: message.id, kind: 'TIME_SKEW' });
    await expectPrismaCode(createReview({ bankMessageId: message.id, kind: 'NO_MATCH' }), 'P2002');
  });

  it('every review names a bank message that exists (NOT NULL + foreign key)', async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "PaymentReview" ("id", "kind", "updatedAt") VALUES ('r-null', 'NO_MATCH', now())`,
      ),
    ).rejects.toThrow(/bankMessageId|null value/i);
    await expectPrismaCode(createReview({ bankMessageId: 'no-such-message' }), 'P2003');
  });

  it('accepts the newer kinds and the DRAINING card status', async () => {
    for (const kind of [
      'CANCELLED_LATE',
      'DAILY_LIMIT',
      'POSSIBLE_REVERSAL',
      'USER_BLOCKED',
    ] as const) {
      await createReview({ kind });
    }
    await createCard({ status: 'DRAINING' });
  });
});

describe('BankMessageOutcome', () => {
  const outcomeOf = (bankMessageId: string, extra: object) =>
    db.bankMessageOutcome.create({
      data: { bankMessageId, chainStatus: 'OK', outcome: 'DEBIT_RECORDED', ...extra },
    });

  it('one outcome per message', async () => {
    const first = await p2pFixture();
    const second = await createBankMessage();
    const payment = await db.payment.create({
      data: paymentData(first.userId, first.messageId, { intentId: first.intentId }),
    });
    await outcomeOf(first.messageId, { outcome: 'CREDITED', paymentId: payment.id });
    await expectPrismaCode(
      outcomeOf(first.messageId, { outcome: 'CREDITED', paymentId: payment.id }),
      'P2002',
    );
    expect(second.id).not.toBe(first.messageId);
  });

  it('GG005: an outcome names only the payment and the review of its own bank message', async () => {
    const first = await p2pFixture();
    const other = await p2pFixture();
    const payment = await db.payment.create({
      data: paymentData(first.userId, first.messageId, { intentId: first.intentId }),
    });
    const review = await createReview({ bankMessageId: first.messageId });
    // The payment of message A cannot be the outcome of message B (nor can A's review).
    await expectGuard(
      outcomeOf(other.messageId, { outcome: 'CREDITED', paymentId: payment.id }),
      'belongs to another bank message',
      'GG005',
    );
    await expectGuard(
      outcomeOf(other.messageId, { outcome: 'REVIEW', reviewId: review.id }),
      'belongs to another bank message',
      'GG005',
    );
    await outcomeOf(first.messageId, { outcome: 'CREDITED', paymentId: payment.id });
    await db.bankMessageOutcome.create({
      data: {
        bankMessageId: other.messageId,
        chainStatus: 'OK',
        outcome: 'REVIEW',
        reviewId: (await createReview({ bankMessageId: other.messageId })).id,
      },
    });
  });

  it('BankMessageOutcome_payment_check: CREDITED exactly when a payment is named', async () => {
    const f = await p2pFixture();
    const payment = await db.payment.create({
      data: paymentData(f.userId, f.messageId, { intentId: f.intentId }),
    });
    const [m1, m3] = [await createBankMessage(), await createBankMessage()];
    await expectCheck(
      outcomeOf(m1.id, { outcome: 'CREDITED' }),
      'BankMessageOutcome_payment_check',
    );
    for (const outcome of ['DEBIT_RECORDED', 'CARD_VERIFIED'] as const) {
      await expectCheck(
        outcomeOf(f.messageId, { outcome, paymentId: payment.id }),
        'BankMessageOutcome_payment_check',
      );
    }
    await outcomeOf(m3.id, { outcome: 'CARD_VERIFIED' });
  });

  it('BankMessageOutcome_review_check: a REVIEW outcome names its review', async () => {
    const [m1, m2, m3] = [
      await createBankMessage(),
      await createBankMessage(),
      await createBankMessage(),
    ];
    await expectCheck(outcomeOf(m1.id, { outcome: 'REVIEW' }), 'BankMessageOutcome_review_check');
    const review = await createReview({ bankMessageId: m2.id });
    await outcomeOf(m2.id, { outcome: 'REVIEW', reviewId: review.id });
    await outcomeOf(m3.id, {}); // DEBIT_RECORDED needs no review
  });

  it('payment and review ids are real rows (foreign keys, Restrict)', async () => {
    const [m1, m2] = [await createBankMessage(), await createBankMessage()];
    await expectPrismaCode(
      outcomeOf(m1.id, { outcome: 'CREDITED', paymentId: 'no-such-payment' }),
      'P2003',
    );
    await expectPrismaCode(
      outcomeOf(m2.id, { outcome: 'REVIEW', reviewId: 'no-such-review' }),
      'P2003',
    );
  });
});
