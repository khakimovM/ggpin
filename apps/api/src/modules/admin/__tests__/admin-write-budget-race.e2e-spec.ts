import { randomUUID } from 'node:crypto';
import { ADMIN_CODELESS_DAILY_MAX_COUNT, ADMIN_CODELESS_DAILY_MAX_TIYIN } from '@repo/shared';
import { useAdminE2e } from './admin-e2e.harness';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S6 re-review (N-1, N-3): the codeless daily budget of one admin under parallel actions
// on different wallets (only the admin's advisory budget lock serialises them: the wallet locks
// differ), and a reversal past the budget done with the code bound to the daily-limit flag.
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

/** Users each funded with `fundTiyin`, the targets of the parallel debits. */
async function fundedUsers(n: number, fundTiyin: bigint): Promise<string[]> {
  const users: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const userId = await kit.user();
    await kit.payment(userId, fundTiyin);
    users.push(userId);
  }
  return users;
}

/** Runs the debits at once; exactly one passes, the rest ask for the code; one entry written. */
async function exactlyOnePasses(owner: Session, users: readonly string[], amountTiyin: bigint) {
  const results = await Promise.all(users.map((userId) => debit(owner, userId, -amountTiyin)));
  const codes = results.map((r) => r.statusCode).sort();
  expect(codes).toEqual([200, ...users.slice(1).map(() => 400)]);
  for (const r of results.filter((res) => res.statusCode === 400)) {
    expect(errorOf(r).details).toEqual(OTP_REQUIRED);
  }
  const written = await t.db().ledgerEntry.count({
    where: { userId: { in: [...users] }, kind: 'ADJUSTMENT' },
  });
  expect(written).toBe(1);
}

describe('codeless budget under parallel debits of one admin (N-1)', () => {
  it('count = MAX - 1: of three parallel codeless debits to different users exactly one passes', async () => {
    const owner = await kit.session('OWNER');
    const spent = await kit.user();
    await kit.payment(spent, 1_000_000n);
    for (let i = 0; i < ADMIN_CODELESS_DAILY_MAX_COUNT - 1; i += 1) {
      expect((await debit(owner, spent, -100n)).statusCode).toBe(200);
    }
    await exactlyOnePasses(owner, await fundedUsers(3, 1_000n), 100n);
  });

  it('sum = MAX - X: of three parallel -X debits to different users exactly one passes', async () => {
    const owner = await kit.session('OWNER');
    const threshold = t.env.ADMIN_CONFIRM_THRESHOLD_TIYIN;
    const X = 1_000_000n;
    expect(ADMIN_CODELESS_DAILY_MAX_TIYIN).toBe(threshold * 2n); // the test env's threshold
    const spent = await kit.user();
    await kit.payment(spent, ADMIN_CODELESS_DAILY_MAX_TIYIN);
    expect((await debit(owner, spent, -threshold)).statusCode).toBe(200);
    expect((await debit(owner, spent, -(threshold - X))).statusCode).toBe(200);
    await exactlyOnePasses(owner, await fundedUsers(3, X), X);
  });

  // Deterministic form of the race: another codeless debit of the same admin holds the budget
  // lock with its (10th) audit row and entry not yet committed. With the lock, the panel debit
  // waits, then counts that row and asks for the code; without it, it would read 9 and pass (the
  // mutant this test exists for).
  it('a debit waits for a concurrent codeless debit holding the budget lock, then counts it', async () => {
    const owner = await kit.session('OWNER');
    const adminId = owner.admin.id;
    const spent = await kit.user();
    await kit.payment(spent, 1_000_000n);
    for (let i = 0; i < ADMIN_CODELESS_DAILY_MAX_COUNT - 1; i += 1) {
      expect((await debit(owner, spent, -100n)).statusCode).toBe(200);
    }
    const [target] = await fundedUsers(1, 1_000n);
    if (target === undefined) throw new Error('no target user');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const other = t.db().$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-codeless:${adminId}`}, 0))`;
        const audit = await tx.auditLog.create({
          data: {
            actorType: 'ADMIN',
            actorId: adminId,
            action: 'WALLET_ADJUST',
            targetType: 'User',
            targetId: spent,
            after: { otpVerified: false },
            reason: REASON,
          },
        });
        await tx.ledgerEntry.create({
          data: {
            userId: spent,
            kind: 'ADJUSTMENT',
            amountTiyin: -100n,
            refType: 'ADMIN_ACTION',
            refId: audit.id,
          },
        });
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const late = debit(owner, target, -100n);
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await other;
    const res = await late;
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).details).toEqual(OTP_REQUIRED);
    expect(await kit.balance(target)).toBe(1_000n);
  });
});

describe('reversal past the codeless budget (N-3)', () => {
  it('budget spent: the reversal asks, the code bound to the daily-limit flag is issued and the reversal takes it', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const paymentId = await kit.payment(userId, 1_000n);
    const ask = { action: 'payments.reverse' as const, targetId: paymentId, amountTiyin: '1000' };
    const notYet = await kit.post(owner, 'confirmations', ask, null);
    expect(errorOf(notYet).details).toEqual([{ path: 'action', code: 'OTP_NOT_REQUIRED' }]);

    const spent = await kit.user();
    await kit.payment(spent, 1_000_000n);
    for (let i = 0; i < ADMIN_CODELESS_DAILY_MAX_COUNT; i += 1) {
      expect((await debit(owner, spent, -100n)).statusCode).toBe(200);
    }
    const key = randomUUID();
    const codeless = await kit.post(
      owner,
      `payments/${paymentId}/reverse`,
      { reason: REASON },
      key,
    );
    expect(errorOf(codeless).details).toEqual(OTP_REQUIRED);

    const otp = await kit.code(owner, ask);
    const body = { reason: REASON, confirmAmountTiyin: '1000', otp };
    const res = await kit.post(owner, `payments/${paymentId}/reverse`, body, key);
    expect(res.statusCode).toBe(200);
    const done = dataOf<{ auditId: string; ledgerEntryId: string; balanceTiyin: string }>(res);
    expect(done).toMatchObject({ applied: true, balanceTiyin: '0' });

    const entries = await t.db().ledgerEntry.findMany({
      where: { refType: 'PAYMENT', refId: paymentId, kind: 'TOPUP_REVERSAL' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: done.ledgerEntryId, userId, amountTiyin: -1_000n });
    expect(await kit.balance(userId)).toBe(0n);
    const payment = await t.db().payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('CANCELLED');
    const row = await t.db().auditLog.findUniqueOrThrow({ where: { id: done.auditId } });
    expect(row).toMatchObject({ actorType: 'ADMIN', actorId: owner.admin.id });
    expect(row.after).toMatchObject({ otpVerified: true, reversedTiyin: '1000' });
  });
});
