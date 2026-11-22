import { randomUUID } from 'node:crypto';
import { AdminAdjustWalletResponseSchema, tashkentDayStart } from '@repo/shared';
import { manualCreditsSince } from '@repo/db';
import { manualCreditTotalSince } from '../../../common/admin/manual-credit.repository';
import { WalletAdminService } from '../../wallet/wallet-admin.service';
import { useAdminE2e } from './admin-e2e.harness';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S6: `POST /admin/users/:id/adjust-wallet` and `POST /admin/confirmations`
// (docs/04 «Tasdiq kodi», D-63 (4), (5), D-65 D1) with the rules/70 money set.
const t = useAdminE2e();
const kit = adminWriteKit(t);
const REASON = 'paid by hand after a bank check';

type Adjust = { ledgerEntryId: string; auditId: string; applied: boolean; frozen: boolean };

const adjustBody = (amountTiyin: bigint, extra: object = {}) => ({
  amountTiyin: amountTiyin.toString(),
  reason: REASON,
  ...extra,
});

/** A credit with its code: confirmations first, then the action with the same key. */
async function credit(owner: Session, userId: string, amountTiyin: bigint, key = randomUUID()) {
  const otp = await kit.code(owner, {
    action: 'users.adjustWallet',
    targetId: userId,
    amountTiyin: amountTiyin.toString(),
    idempotencyKey: key,
  });
  const body = adjustBody(amountTiyin, { confirmAmountTiyin: amountTiyin.toString(), otp });
  return { res: await kit.post(owner, `users/${userId}/adjust-wallet`, body, key), key, body };
}

describe('admin adjust-wallet (S6)', () => {
  it('a debit at or below the threshold needs no code: one ADJUSTMENT, ADMIN audit, replay, 409, adminAction', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await kit.payment(userId, 2_000_000n);
    const key = randomUUID();
    const res = await kit.post(owner, `users/${userId}/adjust-wallet`, adjustBody(-500_000n), key);
    expect(res.statusCode).toBe(200);
    const done = AdminAdjustWalletResponseSchema.parse(dataOf(res));
    expect(done).toMatchObject({ balanceTiyin: '1500000', frozen: false, applied: true });
    const entry = await t.db().ledgerEntry.findUniqueOrThrow({ where: { id: done.ledgerEntryId } });
    expect(entry).toMatchObject({
      kind: 'ADJUSTMENT',
      amountTiyin: -500_000n,
      refType: 'ADMIN_ACTION',
      refId: done.auditId,
    });
    const audit = await t.db().auditLog.findUniqueOrThrow({ where: { id: done.auditId } });
    expect(audit).toMatchObject({
      actorType: 'ADMIN',
      actorId: owner.admin.id,
      action: 'WALLET_ADJUST',
    });
    expect(audit.after).toMatchObject({ adminRole: 'OWNER', otpVerified: false });
    expect(await kit.alerts('adminAction', done.auditId)).toBe(1);

    const again = await kit.post(
      owner,
      `users/${userId}/adjust-wallet`,
      adjustBody(-500_000n),
      key,
    );
    expect(dataOf(again)).toMatchObject({ ledgerEntryId: done.ledgerEntryId, applied: false });
    const other = await kit.post(
      owner,
      `users/${userId}/adjust-wallet`,
      adjustBody(-400_000n),
      key,
    );
    expect(errorOf(other).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await kit.balance(userId)).toBe(1_500_000n);
  });

  it('OPERATOR and SUPPORT get 404 for the action and for its code', async () => {
    const userId = await kit.user();
    for (const role of ['OPERATOR', 'SUPPORT'] as const) {
      const who = await kit.session(role);
      expect(
        (await kit.post(who, `users/${userId}/adjust-wallet`, adjustBody(-1n))).statusCode,
      ).toBe(404);
      const ask = await kit.post(
        who,
        'confirmations',
        {
          action: 'users.adjustWallet',
          targetId: userId,
          amountTiyin: '5',
          idempotencyKey: randomUUID(),
        },
        null,
      );
      expect(ask.statusCode).toBe(404);
    }
  });

  it('a credit always needs the code; after a 4xx the same key takes another body; another otp replays', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const key = randomUUID();
    const bare = await kit.post(owner, `users/${userId}/adjust-wallet`, adjustBody(300_000n), key);
    expect(bare.statusCode).toBe(400);
    expect(errorOf(bare).details).toEqual([{ path: 'otp', code: 'OTP_REQUIRED' }]);

    const first = await credit(owner, userId, 250_000n, key); // same key, another body: no 409
    expect(first.res.statusCode).toBe(200);
    const done = dataOf<Adjust>(first.res);
    expect(done.applied).toBe(true);
    const row = await t.db().auditLog.findUniqueOrThrow({ where: { id: done.auditId } });
    expect(row.after).toMatchObject({ otpVerified: true });

    // Same key and body with another (fresh) code: the replay, not a 409 and not a second entry.
    const otp = await kit.code(owner, {
      action: 'users.adjustWallet',
      targetId: userId,
      amountTiyin: '250000',
      idempotencyKey: key,
    });
    const replay = await kit.post(
      owner,
      `users/${userId}/adjust-wallet`,
      { ...first.body, otp },
      key,
    );
    expect(dataOf(replay)).toMatchObject({ ledgerEntryId: done.ledgerEntryId, applied: false });
    expect(await kit.balance(userId)).toBe(250_000n);
  });

  it('the code is bound to the session, the amount and the key', async () => {
    const owner = await kit.session('OWNER');
    const second = { admin: owner.admin, cookie: (await t.login(owner.admin)).cookie };
    const userId = await kit.user();
    const key = randomUUID();
    const otp = await kit.code(owner, {
      action: 'users.adjustWallet',
      targetId: userId,
      amountTiyin: '100000',
      idempotencyKey: key,
    });
    const body = adjustBody(100_000n, { confirmAmountTiyin: '100000', otp });
    const elsewhere = await kit.post(second, `users/${userId}/adjust-wallet`, body, key);
    expect(elsewhere.statusCode).toBe(422);
    expect(errorOf(elsewhere)).toEqual({ code: 'CODE_INVALID', details: { attemptsLeft: 4 } });
    const otherKey = await kit.post(owner, `users/${userId}/adjust-wallet`, body, randomUUID());
    expect(errorOf(otherKey).code).toBe('CODE_INVALID');
    const another = await kit.post(
      owner,
      `users/${userId}/adjust-wallet`,
      { ...body, otp: { ...otp, code: otp.code === '000000' ? '000001' : '000000' } },
      key,
    );
    expect(errorOf(another)).toEqual({ code: 'CODE_INVALID', details: { attemptsLeft: 2 } });
    expect((await kit.post(owner, `users/${userId}/adjust-wallet`, body, key)).statusCode).toBe(
      200,
    );
    expect(await kit.balance(userId)).toBe(100_000n);

    // A code made for the re-typed 99 999 checks out, but it is not the real amount.
    const key2 = randomUUID();
    const typo = await kit.code(owner, {
      action: 'users.adjustWallet',
      targetId: userId,
      amountTiyin: '99999',
      idempotencyKey: key2,
    });
    const body2 = adjustBody(100_000n, { confirmAmountTiyin: '99999', otp: typo });
    const mismatch = await kit.post(owner, `users/${userId}/adjust-wallet`, body2, key2);
    expect(errorOf(mismatch).details).toEqual([
      { path: 'confirmAmountTiyin', code: 'AMOUNT_MISMATCH' },
    ]);
    expect(await kit.balance(userId)).toBe(100_000n);
  });

  it('confirmations: OTP_NOT_REQUIRED for a small debit; the daily quota answers 429 + Retry-After', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const small = await kit.post(
      owner,
      'confirmations',
      {
        action: 'users.adjustWallet',
        targetId: userId,
        amountTiyin: '-5',
        idempotencyKey: randomUUID(),
      },
      null,
    );
    expect(errorOf(small).details).toEqual([{ path: 'action', code: 'OTP_NOT_REQUIRED' }]);
    const max = t.env.ADMIN_OTP_DAILY_MAX;
    Object.assign(t.env, { ADMIN_OTP_DAILY_MAX: 2 });
    try {
      const ask = { action: 'users.adjustWallet', targetId: userId, amountTiyin: '5' } as const;
      for (let i = 0; i < 2; i += 1) {
        await kit.code(owner, { ...ask, idempotencyKey: randomUUID() });
      }
      const third = await kit.post(
        owner,
        'confirmations',
        { ...ask, idempotencyKey: randomUUID() },
        null,
      );
      expect(third.statusCode).toBe(429);
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      Object.assign(t.env, { ADMIN_OTP_DAILY_MAX: max });
    }
  });

  it('two identical requests at once: one entry, both answered', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const key = randomUUID();
    const send = () => kit.post(owner, `users/${userId}/adjust-wallet`, adjustBody(-1_000n), key);
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([dataOf<Adjust>(a).applied, dataOf<Adjust>(b).applied].sort()).toEqual([false, true]);
    expect(await t.db().ledgerEntry.count({ where: { userId, kind: 'ADJUSTMENT' } })).toBe(1);
  });

  it('a debit below zero freezes purchases and raises walletFrozen', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const res = await kit.post(owner, `users/${userId}/adjust-wallet`, adjustBody(-7_000n));
    expect(dataOf(res)).toMatchObject({ balanceTiyin: '-7000', frozen: true, applied: true });
    expect(await kit.alerts('walletFrozen', userId)).toBe(1);
  });

  it('daily cap: CLI and panel together, exactly the cap passes, one tiyin more is refused; manualCreditsSince sees it', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const cap = t.env.ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN;
    const since = tashkentDayStart(t.clock.now());
    try {
      const used = await manualCreditTotalSince(t.db(), since);
      Object.assign(t.env, { ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: used + 30_000n });
      const viaCli = await t.app().get(WalletAdminService).adjust({
        userId,
        amountTiyin: 10_000n,
        reason: REASON,
        operator: 'e2e-owner',
      });
      expect(viaCli.applied).toBe(true);
      const exact = await credit(owner, userId, 20_000n); // used + 30 000 = the cap itself
      expect(dataOf(exact.res)).toMatchObject({ applied: true });
      const over = await credit(owner, userId, 1n);
      expect(errorOf(over.res).details).toEqual([
        { path: 'amountTiyin', code: 'MANUAL_CREDIT_DAILY_CAP' },
      ]);
      const cliOver = await t
        .app()
        .get(WalletAdminService)
        .adjust({
          userId,
          amountTiyin: 1n,
          reason: REASON,
          operator: 'e2e-owner',
        })
        .catch((e: unknown) => e);
      expect(cliOver).toMatchObject({
        details: { field: 'amountTiyin', reason: 'MANUAL_CREDIT_DAILY_CAP' },
      });
      const manual = await manualCreditsSince(t.db(), userId, since);
      expect(manual.adjust).toEqual({ count: 2, sumTiyin: 30_000n });
    } finally {
      Object.assign(t.env, { ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: cap });
    }
  });
});
