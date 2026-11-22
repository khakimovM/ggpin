import { randomUUID } from 'node:crypto';
import {
  ADMIN_CODELESS_BUDGET_FLAG,
  ADMIN_CODELESS_DAILY_MAX_COUNT,
  ADMIN_CODELESS_DAILY_MAX_TIYIN,
  tashkentDayStart,
} from '@repo/shared';
import { manualCreditTotalSince } from '../../../common/admin/manual-credit.repository';
import { useAdminE2e } from './admin-e2e.harness';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S6 fix round: the codeless daily budget of one admin (owner decision 2026-11-18,
// SA-S6-3), the global manual-credit cap under parallel credits (C-3) and the adjustment bound
// (SA-S6-6), through the real HTTP routes and Postgres.
const t = useAdminE2e();
const kit = adminWriteKit(t);
const REASON = 'charged back by hand';
const OTP_REQUIRED = [{ path: 'otp', code: 'OTP_REQUIRED' }];

const debit = (who: Session, userId: string, amountTiyin: bigint, key = randomUUID()) =>
  kit.post(
    who,
    `users/${userId}/adjust-wallet`,
    { amountTiyin: amountTiyin.toString(), reason: REASON },
    key,
  );

describe('admin codeless daily budget (SA-S6-3)', () => {
  it('ten codeless debits pass, the 11th asks for the code bound to the daily-limit flag; another admin is not counted', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await kit.payment(userId, 1_000_000n);
    for (let i = 0; i < ADMIN_CODELESS_DAILY_MAX_COUNT; i += 1) {
      expect((await debit(owner, userId, -100n)).statusCode).toBe(200);
    }
    const key = randomUUID();
    const eleventh = await debit(owner, userId, -100n, key);
    expect(errorOf(eleventh).details).toEqual(OTP_REQUIRED);

    // A reversal shares the budget.
    const paymentId = await kit.payment(userId, 1_000n);
    const reverse = await kit.post(owner, `payments/${paymentId}/reverse`, { reason: REASON });
    expect(errorOf(reverse).details).toEqual(OTP_REQUIRED);

    const ask = {
      action: 'users.adjustWallet' as const,
      targetId: userId,
      amountTiyin: '-100',
      idempotencyKey: key,
    };
    const otp = await kit.code(owner, ask);
    const body = { amountTiyin: '-100', reason: REASON, confirmAmountTiyin: '-100', otp };
    const coded = await kit.post(owner, `users/${userId}/adjust-wallet`, body, key);
    expect(coded.statusCode).toBe(200);
    const row = await t.db().auditLog.findUniqueOrThrow({
      where: { id: dataOf<{ auditId: string }>(coded).auditId },
    });
    expect(row.after).toMatchObject({ otpVerified: true });

    // Each admin has a budget of its own.
    const other = await kit.session('OWNER');
    expect((await debit(other, userId, -100n)).statusCode).toBe(200);
    expect(await kit.balance(userId)).toBe(1_001_000n - 1_200n);
  });

  it('the sum: exactly 2 000 000 som with this debit passes, one tiyin more asks', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await kit.payment(userId, ADMIN_CODELESS_DAILY_MAX_TIYIN + 1_000n);
    const threshold = t.env.ADMIN_CONFIRM_THRESHOLD_TIYIN;
    expect(ADMIN_CODELESS_DAILY_MAX_TIYIN).toBe(threshold * 2n); // the test env's threshold
    expect((await debit(owner, userId, -threshold)).statusCode).toBe(200);
    expect((await debit(owner, userId, -(threshold - 1n))).statusCode).toBe(200);
    expect((await debit(owner, userId, -1n)).statusCode).toBe(200); // the cap itself
    expect(errorOf(await debit(owner, userId, -1n)).details).toEqual(OTP_REQUIRED);
  });

  it('the confirmation issues a code only once the budget is passed; the action takes it (same flag on both sides)', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await kit.payment(userId, ADMIN_CODELESS_DAILY_MAX_TIYIN + 1_000n);
    const ask = (key: string) => ({
      action: 'users.adjustWallet' as const,
      targetId: userId,
      amountTiyin: '-5',
      idempotencyKey: key,
    });
    const notYet = await kit.post(owner, 'confirmations', ask(randomUUID()), null);
    expect(errorOf(notYet).details).toEqual([{ path: 'action', code: 'OTP_NOT_REQUIRED' }]);
    const threshold = t.env.ADMIN_CONFIRM_THRESHOLD_TIYIN;
    expect((await debit(owner, userId, -threshold)).statusCode).toBe(200);
    expect((await debit(owner, userId, -threshold)).statusCode).toBe(200);
    // Past the budget: the code is issued, bound to '${ADMIN_CODELESS_BUDGET_FLAG}', and the
    // action computes the same flag, so the code checks out.
    const key = randomUUID();
    const otp = await kit.code(owner, ask(key));
    const body = { amountTiyin: '-5', reason: REASON, confirmAmountTiyin: '-5', otp };
    const res = await kit.post(owner, `users/${userId}/adjust-wallet`, body, key);
    expect(dataOf(res)).toMatchObject({ applied: true });
    expect(ADMIN_CODELESS_BUDGET_FLAG).toBe('otpRequired: daily-limit');
  });
});

describe('manual-credit cap under parallel credits (C-3)', () => {
  it('cap = used + X: of four parallel +X credits to different users exactly one passes', async () => {
    const owner = await kit.session('OWNER');
    const cap = t.env.ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN;
    const X = 40_000n;
    const prepared = [];
    for (let i = 0; i < 4; i += 1) {
      const userId = await kit.user();
      const key = randomUUID();
      const otp = await kit.code(owner, {
        action: 'users.adjustWallet',
        targetId: userId,
        amountTiyin: X.toString(),
        idempotencyKey: key,
      });
      const body = { amountTiyin: X.toString(), reason: REASON, confirmAmountTiyin: '40000', otp };
      prepared.push({ userId, key, body });
    }
    try {
      const used = await manualCreditTotalSince(t.db(), tashkentDayStart(t.clock.now()));
      Object.assign(t.env, { ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: used + X });
      const results = await Promise.all(
        prepared.map((p) => kit.post(owner, `users/${p.userId}/adjust-wallet`, p.body, p.key)),
      );
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 400, 400, 400]);
      for (const r of results.filter((res) => res.statusCode === 400)) {
        expect(errorOf(r).details).toEqual([
          { path: 'amountTiyin', code: 'MANUAL_CREDIT_DAILY_CAP' },
        ]);
      }
      const credited = await t.db().ledgerEntry.count({
        where: { userId: { in: prepared.map((p) => p.userId) }, kind: 'ADJUSTMENT' },
      });
      expect(credited).toBe(1);
    } finally {
      Object.assign(t.env, { ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: cap });
    }
  });
});

describe('manual-credit cap lock (C-3)', () => {
  // Deterministic form of the race: another credit holds the cap lock with its +X entry not yet
  // committed. With the lock, the panel credit waits, then sees that entry and is refused; without
  // it, it would read the old total and pass (the mutant this test exists for).
  it('a credit waits for a concurrent credit holding the cap lock, then sees its entry', async () => {
    const owner = await kit.session('OWNER');
    const cap = t.env.ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN;
    const X = 30_000n;
    const first = await kit.user();
    const second = await kit.user();
    const key = randomUUID();
    const otp = await kit.code(owner, {
      action: 'users.adjustWallet',
      targetId: second,
      amountTiyin: X.toString(),
      idempotencyKey: key,
    });
    const body = { amountTiyin: X.toString(), reason: REASON, confirmAmountTiyin: '30000', otp };
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    try {
      const used = await manualCreditTotalSince(t.db(), tashkentDayStart(t.clock.now()));
      Object.assign(t.env, { ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: used + X });
      const other = t.db().$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('manual-credit-cap', 0))`;
          await tx.ledgerEntry.create({
            data: {
              userId: first,
              kind: 'ADJUSTMENT',
              amountTiyin: X,
              refType: 'ADMIN_ACTION',
              refId: `c3-${randomUUID()}`,
            },
          });
          locked();
          await held;
        },
        { timeout: 20_000 },
      );
      await isLocked;
      const late = kit.post(owner, `users/${second}/adjust-wallet`, body, key);
      await new Promise((resolve) => setTimeout(resolve, 400));
      release();
      await other;
      const res = await late;
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).details).toEqual([
        { path: 'amountTiyin', code: 'MANUAL_CREDIT_DAILY_CAP' },
      ]);
      expect(await kit.balance(second)).toBe(0n);
    } finally {
      Object.assign(t.env, { ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN: cap });
    }
  });
});

describe('adjustment bound (SA-S6-6)', () => {
  it('above 1 000 000 000 som either way the body is refused, nothing written', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    for (const amount of [100_000_000_001n, -100_000_000_001n]) {
      const res = await debit(owner, userId, amount);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
    expect(await t.db().ledgerEntry.count({ where: { userId } })).toBe(0);
  });
});
