import { randomUUID } from 'node:crypto';
import { ReviewRepository } from '../../payments/review.repository';
import { adminAuditIdFor } from '../write/admin-write-key';
import { AdminWriteRepository } from '../write/admin-write.repository';
import type { Res } from './admin-e2e.api';
import { useAdminE2e } from './admin-e2e.harness';
import { waitForLockWaiter } from './admin-e2e.locks';
import { hook } from './admin-write-void.e2e-hook';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// 9-B SA-1, SA-9B1-4: a review credit writes its Payment and TOPUP entry BEFORE its audit row
// (review-credit.service.ts), so a void racing it must still see one outcome only: the credit's
// transaction rolled back -> the void goes in (VOIDED), the credit is 409 and no money moved; it
// committed -> APPLIED with the credit's row. The interleaving is forced on real row locks.
const t = useAdminE2e();
const kit = adminWriteKit(t);
const reviews = () => t.app().get(ReviewRepository);
const writes = () => t.app().get(AdminWriteRepository);
const TOMBSTONE_INSERT = '%"AuditLog"%ON CONFLICT%';
const REASON = 'void race review credit';

const callVoid = (who: Session, key: string, reviewId: string) =>
  kit.post(
    who,
    'write-keys/void',
    { idempotencyKey: key, action: 'payments.reviewCredit', targetId: reviewId },
    null,
  );

/** An OPEN review, a user and the owner's code for crediting it to that user. */
async function creditCall(owner: Session) {
  const userId = await kit.user();
  const { reviewId, amountTiyin } = await kit.review();
  const amount = amountTiyin.toString();
  const otp = await kit.code(owner, {
    action: 'payments.reviewCredit',
    targetId: reviewId,
    amountTiyin: amount,
    userId,
    confirmOverride: false,
    bankVerified: false,
  });
  const credit = (key: string) =>
    kit.post(
      owner,
      `payments/reviews/${reviewId}/credit`,
      { userId, reason: REASON, confirmAmountTiyin: amount, otp },
      key,
    );
  return { userId, reviewId, credit };
}

const moneyOf = async (userId: string, reviewId: string) => ({
  ledger: await t.db().ledgerEntry.count({ where: { userId } }),
  payments: await t.db().payment.count({ where: { userId } }),
  review: (await t.db().paymentReview.findUniqueOrThrow({ where: { id: reviewId } })).status,
});

const noDeadlockLogged = () => expect(t.logs.text()).not.toMatch(/40P01|deadlock/i);

describe('void vs a review credit with the same key (money before the audit row)', () => {
  it('the credit rolls back after its audit insert: VOIDED, the credit 409, no payment, no entry', async () => {
    const owner = await kit.session('OWNER');
    const { userId, reviewId, credit } = await creditCall(owner);
    const key = randomUUID();
    const auditId = adminAuditIdFor(owner.admin.id, key);
    expect(await moneyOf(userId, reviewId)).toEqual({ ledger: 0, payments: 0, review: 'OPEN' });
    const state: { voiding?: Promise<Res>; waited: boolean; failed: boolean } = {
      waited: false,
      failed: false,
    };
    // After the credit's Payment, TOPUP and audit row are written (not committed): the void
    // starts and waits on the audit id; then the credit fails and rolls everything back.
    const h1 = hook(reviews(), 'createAudit', (original) => async (tx, data) => {
      await original(tx, data);
      let settled = false;
      state.voiding = callVoid(owner, key, reviewId).finally(() => {
        settled = true;
      });
      state.waited = await waitForLockWaiter(t.db(), TOMBSTONE_INSERT, () => settled);
      state.failed = true;
      throw new Error('forced rollback after the review credit audit insert');
    });
    // The runner's read after the failure waits for the void's commit (answer: the tombstone).
    const h2 = hook(writes(), 'findAudit', (original) => async (id, db) => {
      if (id === auditId && db === undefined && state.failed) await state.voiding;
      return original(id, db);
    });
    const res = await credit(key).finally(() => {
      h1.restore();
      h2.restore();
    });
    if (state.voiding === undefined) throw new Error('the void never started');
    const voided = await state.voiding;

    expect(state.waited).toBe(true);
    expect(dataOf(voided)).toMatchObject({ status: 'VOIDED', auditId });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await moneyOf(userId, reviewId)).toEqual({ ledger: 0, payments: 0, review: 'OPEN' });
    const row = await t.db().auditLog.findUniqueOrThrow({ where: { id: auditId } });
    expect(row.action).toBe('IDEMPOTENCY_VOID');
    // The same key stays dead: a retry of the credit is 409 too, still nothing credited.
    const retry = await credit(key);
    expect(retry.statusCode).toBe(409);
    expect(await moneyOf(userId, reviewId)).toEqual({ ledger: 0, payments: 0, review: 'OPEN' });
    noDeadlockLogged();
  });

  it('the credit commits while the void waits on its audit id: APPLIED, the credit stands', async () => {
    const owner = await kit.session('OWNER');
    const { userId, reviewId, credit } = await creditCall(owner);
    const key = randomUUID();
    const auditId = adminAuditIdFor(owner.admin.id, key);
    const state: { voiding?: Promise<Res>; waited: boolean } = { waited: false };
    const h = hook(reviews(), 'createAudit', (original) => async (tx, data) => {
      const id = await original(tx, data);
      let settled = false;
      state.voiding = callVoid(owner, key, reviewId).finally(() => {
        settled = true;
      });
      state.waited = await waitForLockWaiter(t.db(), TOMBSTONE_INSERT, () => settled);
      return id;
    });
    const res = await credit(key).finally(h.restore);
    if (state.voiding === undefined) throw new Error('the void never started');
    const voided = await state.voiding;

    expect(state.waited).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)).toMatchObject({ auditId });
    expect(dataOf(voided)).toMatchObject({ status: 'APPLIED', auditId, action: 'REVIEW_CREDIT' });
    expect(await moneyOf(userId, reviewId)).toEqual({
      ledger: 1,
      payments: 1,
      review: 'RESOLVED',
    });
    noDeadlockLogged();
  });
});
