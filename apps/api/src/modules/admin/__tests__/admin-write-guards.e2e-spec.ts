import { randomBytes, randomUUID } from 'node:crypto';
import type { AdminUser } from '@repo/db';
import { useAdminE2e } from './admin-e2e.harness';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S6 fix round: who may be acted on and in what order the refusals come (SA-S6-1,
// SA-S6-4/C-1, SA-S6-5, SA-S6-9, C-4, C-8, C-10 a).
const t = useAdminE2e();
const kit = adminWriteKit(t);
const REASON = { reason: 'abuse report checked' };

/** The store account of an admin (same Telegram id); the harness removes it with the admin. */
async function storeAccountOf(admin: AdminUser, extra: { botBlockedAt?: Date } = {}) {
  const row = await t.db().user.create({
    data: {
      telegramId: admin.telegramId,
      firstName: 'Admin store account',
      referralCode: `adm${randomBytes(6).toString('hex')}`,
      wallet: { create: {} },
      ...extra,
    },
    select: { id: true },
  });
  return row.id;
}

const adjustAsk = (targetId: string, amountTiyin: string) => ({
  action: 'users.adjustWallet' as const,
  targetId,
  amountTiyin,
  idempotencyKey: randomUUID(),
});

async function heldAdminRow(admin: AdminUser, change: Partial<AdminUser>) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: () => void = () => undefined;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = t.db().$transaction(
    async (tx) => {
      await tx.adminUser.update({ where: { id: admin.id }, data: change });
      locked();
      await held;
    },
    { timeout: 20_000 },
  );
  await isLocked;
  return { release, done };
}

describe('admin write guards (S6 fix round)', () => {
  it('SA-S6-1: an OPERATOR cannot block or freeze the OWNER store account; OWNER neither; nothing written', async () => {
    const owner = await kit.session('OWNER');
    const operator = await kit.session('OPERATOR');
    const ownerUser = await storeAccountOf(owner.admin);
    const operatorUser = await storeAccountOf(operator.admin);
    const refused = [{ path: 'userId', code: 'ADMIN_ACCOUNT' }];
    for (const [who, target] of [
      [operator, ownerUser],
      [owner, operatorUser],
    ] as const) {
      for (const action of ['block', 'freeze']) {
        const res = await kit.post(who, `users/${target}/${action}`, REASON);
        expect(res.statusCode).toBe(400);
        expect(errorOf(res).details).toEqual(refused);
      }
    }
    const rows = await t.db().user.findMany({ where: { id: { in: [ownerUser, operatorUser] } } });
    expect(rows.map((r) => [r.isBlocked, r.purchaseFrozen])).toEqual([
      [false, false],
      [false, false],
    ]);
    const audits = await t.db().auditLog.count({
      where: { targetId: { in: [ownerUser, operatorUser] } },
    });
    expect(audits).toBe(0);
  });

  it('C-1: OPERATOR asking a code for a resolved review gets 404, before any state read; OWNER gets the domain refusal (SA-S6-5)', async () => {
    const owner = await kit.session('OWNER');
    const operator = await kit.session('OPERATOR');
    const userId = await kit.user();
    const { reviewId, amountTiyin } = await kit.review();
    const amount = amountTiyin.toString();
    const ask = {
      action: 'payments.reviewCredit' as const,
      targetId: reviewId,
      amountTiyin: amount,
      userId,
      confirmOverride: false,
      bankVerified: false,
    };
    const otp = await kit.code(owner, ask);
    const credited = await kit.post(owner, `payments/reviews/${reviewId}/credit`, {
      userId,
      reason: REASON.reason,
      confirmAmountTiyin: amount,
      otp,
    });
    expect(credited.statusCode).toBe(200);

    const asOperator = await kit.post(operator, 'confirmations', ask, null);
    expect(asOperator.statusCode).toBe(404);
    const asOwner = await kit.post(owner, 'confirmations', ask, null);
    expect(asOwner.statusCode).toBe(400);
    expect(errorOf(asOwner).details).toEqual([{ path: 'reviewStatus', code: 'RESOLVED' }]);
  });

  it('SA-S6-5: a bot the admin blocked is OTP_UNAVAILABLE in the fields shape', async () => {
    const owner = await kit.session('OWNER');
    await storeAccountOf(owner.admin, { botBlockedAt: new Date() });
    const userId = await kit.user();
    const res = await kit.post(owner, 'confirmations', adjustAsk(userId, '5'), null);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).details).toEqual([{ path: 'otp', code: 'OTP_UNAVAILABLE' }]);
  });

  it('SA-S6-9 / C-10 a: no code and no adjustment for the own account; no code for an unknown user', async () => {
    const owner = await kit.session('OWNER');
    const own = await storeAccountOf(owner.admin);
    const selfTarget = [{ path: 'userId', code: 'SELF_TARGET' }];
    const ask = await kit.post(owner, 'confirmations', adjustAsk(own, '500000'), null);
    expect(errorOf(ask).details).toEqual(selfTarget);
    const debit = await kit.post(owner, `users/${own}/adjust-wallet`, {
      amountTiyin: '-100',
      reason: REASON.reason,
    });
    expect(errorOf(debit).details).toEqual(selfTarget);
    expect(await t.db().ledgerEntry.count({ where: { userId: own } })).toBe(0);

    // A review credit to the own account is refused at its code already.
    const { reviewId, amountTiyin } = await kit.review();
    const review = await kit.post(
      owner,
      'confirmations',
      {
        action: 'payments.reviewCredit',
        targetId: reviewId,
        amountTiyin: amountTiyin.toString(),
        userId: own,
        confirmOverride: false,
        bankVerified: false,
      },
      null,
    );
    expect(errorOf(review).details).toEqual(selfTarget);

    const unknown = `cm${randomBytes(11).toString('hex')}`;
    const none = await kit.post(owner, 'confirmations', adjustAsk(unknown, '500000'), null);
    expect(none.statusCode).toBe(404);
  });

  it('C-4: a reversed payment is ALREADY_REVERSED for another key or another admin; the same key replays', async () => {
    const owner = await kit.session('OWNER');
    const other = await kit.session('OWNER');
    const userId = await kit.user();
    const paymentId = await kit.payment(userId, 200_000n);
    const key = randomUUID();
    const body = { reason: REASON.reason };
    const first = await kit.post(owner, `payments/${paymentId}/reverse`, body, key);
    expect(dataOf(first)).toMatchObject({ applied: true });
    const replay = await kit.post(owner, `payments/${paymentId}/reverse`, body, key);
    expect(dataOf(replay)).toMatchObject({ applied: false });
    for (const who of [owner, other]) {
      const again = await kit.post(who, `payments/${paymentId}/reverse`, {
        reason: 'reversing it a second time',
      });
      expect(again.statusCode).toBe(400);
      expect(errorOf(again).details).toEqual([{ path: 'paymentStatus', code: 'ALREADY_REVERSED' }]);
    }
    expect(await kit.balance(userId)).toBe(0n);
  });

  it('C-8: a code issued to one admin does not work for another admin', async () => {
    const owner = await kit.session('OWNER');
    const other: Session = await kit.session('OWNER');
    const userId = await kit.user();
    const ask = adjustAsk(userId, '70000');
    const otp = await kit.code(owner, ask);
    const body = { amountTiyin: '70000', reason: REASON.reason, confirmAmountTiyin: '70000', otp };
    const res = await kit.post(other, `users/${userId}/adjust-wallet`, body, ask.idempotencyKey);
    expect(res.statusCode).toBe(422);
    expect(errorOf(res).code).toBe('CODE_INVALID');
    expect(await kit.balance(userId)).toBe(0n);
  });

  it('C-8: an OWNER demoted while the action waits on its row is refused in the transaction', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await kit.payment(userId, 100_000n);
    const held = await heldAdminRow(owner.admin, { role: 'OPERATOR' });
    const late = kit.post(owner, `users/${userId}/adjust-wallet`, {
      amountTiyin: '-100',
      reason: REASON.reason,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    held.release();
    await held.done;
    expect((await late).statusCode).toBe(404);
    expect(await t.db().ledgerEntry.count({ where: { userId, kind: 'ADJUSTMENT' } })).toBe(0);
  });

  it('cards: raising a limit needs no code and its code route says OTP_NOT_REQUIRED', async () => {
    const owner = await kit.session('OWNER');
    const card = await kit.card();
    const raised = (card.receiveLimitTiyin + 1n).toString();
    const ask = await kit.post(
      owner,
      'confirmations',
      { action: 'cards.limit', targetId: card.id, receiveLimitTiyin: raised },
      null,
    );
    expect(errorOf(ask).details).toEqual([{ path: 'action', code: 'OTP_NOT_REQUIRED' }]);
    const res = await kit.post(owner, `payments/cards/${card.id}/limit`, {
      receiveLimitTiyin: raised,
      reason: REASON.reason,
    });
    expect(dataOf(res)).toMatchObject({ applied: true, card: { receiveLimitTiyin: raised } });
  });
});
