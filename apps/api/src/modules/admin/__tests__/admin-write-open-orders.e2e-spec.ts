import { randomUUID } from 'node:crypto';
import { AdminAdjustPreviewResponseSchema } from '@repo/shared';
import { useAdminE2e } from './admin-e2e.harness';
import { orderOf, setOrderStatus } from './admin-open-orders.fixtures';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S7a, I-5 (Q2 = B, docs/04 «Ochiq buyurtmalar»): a positive adjustment for a user with
// open orders needs `confirmOpenOrdersSet`, bound into the code and checked under the wallet
// lock; with the rules/70 money set (happy path, replay, concurrency, roles).
const t = useAdminE2e();
const kit = adminWriteKit(t);
const API = '/api/v1/admin';
const REASON = 'compensation for a held order';
const OPEN_ORDERS = [{ path: 'user', code: 'OPEN_ORDERS' }];

type Adjust = { ledgerEntryId: string; auditId: string; applied: boolean };

async function setOf(owner: Session, userId: string, amount: bigint): Promise<string | null> {
  const res = await t.request(
    'GET',
    `${API}/users/${userId}/adjust-preview?amountTiyin=${amount.toString()}`,
    t.spa({ cookie: owner.cookie }),
  );
  return AdminAdjustPreviewResponseSchema.parse(dataOf(res)).confirmOpenOrdersSet;
}

/** A credit: the code for exactly this body (set included), then the action with the same key. */
async function credit(owner: Session, userId: string, amount: bigint, set: string | null) {
  const key = randomUUID();
  const open = set === null ? {} : { confirmOpenOrdersSet: set };
  const otp = await kit.code(owner, {
    action: 'users.adjustWallet',
    targetId: userId,
    amountTiyin: amount.toString(),
    ...open,
    idempotencyKey: key,
  });
  const body = {
    amountTiyin: amount.toString(),
    reason: REASON,
    confirmAmountTiyin: amount.toString(),
    ...open,
    otp,
  };
  return { key, body, send: () => kit.post(owner, `users/${userId}/adjust-wallet`, body, key) };
}

/** The code request alone: refused at once while a set is missing or stale (S7a-fix). */
const askCode = (owner: Session, userId: string, amount: bigint, set: string | null) =>
  kit.post(
    owner,
    'confirmations',
    {
      action: 'users.adjustWallet',
      targetId: userId,
      amountTiyin: amount.toString(),
      ...(set === null ? {} : { confirmOpenOrdersSet: set }),
      idempotencyKey: randomUUID(),
    },
    null,
  );

const adjustments = (userId: string) =>
  t.db().ledgerEntry.count({ where: { userId, kind: 'ADJUSTMENT' } });

describe('admin adjust-wallet: open orders (I-5)', () => {
  it('a HELD order: refused without the set, nothing written; with the set applied, audited, replayed', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const order = await orderOf(t.db(), userId, 'HELD');

    // No set: no code at all (owner decision 2026-11-22); the action would refuse it too.
    const bare = await askCode(owner, userId, 50_000n, null);
    expect(bare.statusCode).toBe(400);
    expect(errorOf(bare).details).toEqual(OPEN_ORDERS);
    expect(await adjustments(userId)).toBe(0);
    expect(await t.db().auditLog.count({ where: { targetId: userId } })).toBe(0);

    const set = await setOf(owner, userId, 50_000n);
    expect(set).toMatch(/^[0-9a-f]{12}$/);
    const first = await credit(owner, userId, 50_000n, set);
    const done = await first.send();
    expect(done.statusCode).toBe(200);
    const applied = dataOf<Adjust>(done);
    expect(applied.applied).toBe(true);
    const audit = await t.db().auditLog.findUniqueOrThrow({ where: { id: applied.auditId } });
    expect(audit.after).toMatchObject({ openOrders: [order.id], otpVerified: true });

    // The same key and body again, after another order appeared: the replay comes first.
    await orderOf(t.db(), userId, 'PAID');
    const again = await first.send();
    expect(dataOf(again)).toMatchObject({ ledgerEntryId: applied.ledgerEntryId, applied: false });
    expect(await adjustments(userId)).toBe(1);
    expect(await kit.balance(userId)).toBe(50_000n);
  });

  it('a stale set (an order created after the preview) is 400 at the code; nothing written', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await orderOf(t.db(), userId, 'NEEDS_REVIEW');
    const stale = await setOf(owner, userId, 10_000n);
    await orderOf(t.db(), userId, 'QUEUED');
    const res = await askCode(owner, userId, 10_000n, stale);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).details).toEqual(OPEN_ORDERS);
    expect(await adjustments(userId)).toBe(0);
  });

  it('the set changes after the code was issued: 422 CODE_INVALID (bound to the old set); nothing written', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const order = await orderOf(t.db(), userId, 'PROCESSING');
    const set = await setOf(owner, userId, 10_000n);
    const ready = await credit(owner, userId, 10_000n, set);
    await setOrderStatus(t.db(), order.id, 'DELIVERED'); // the set is now empty
    const res = await ready.send();
    expect(res.statusCode).toBe(422);
    expect(errorOf(res).code).toBe('CODE_INVALID');
    expect(await adjustments(userId)).toBe(0);
  });

  it('closed orders do not count; a debit is never held back by open ones', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    for (const status of ['DELIVERED', 'FAILED', 'CANCELLED', 'REFUNDED'] as const) {
      await orderOf(t.db(), userId, status);
    }
    expect(await setOf(owner, userId, 1_000n)).toBeNull();
    const plain = await (await credit(owner, userId, 1_000n, null)).send();
    expect(dataOf(plain)).toMatchObject({ applied: true });

    await orderOf(t.db(), userId, 'HELD');
    const debit = await kit.post(owner, `users/${userId}/adjust-wallet`, {
      amountTiyin: '-500',
      reason: REASON,
    });
    expect(debit.statusCode).toBe(200);
    expect(dataOf(debit)).toMatchObject({ applied: true, balanceTiyin: '500' });
    const audit = await t.db().auditLog.findUniqueOrThrow({
      where: { id: dataOf<Adjust>(debit).auditId },
    });
    expect(audit.after).toMatchObject({ openOrders: [] });
  });

  it('two identical requests at once with the set: one ledger entry', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await orderOf(t.db(), userId, 'HELD');
    const set = await setOf(owner, userId, 20_000n);
    const ready = await credit(owner, userId, 20_000n, set);
    const [a, b] = await Promise.all([ready.send(), ready.send()]);
    const codes = [a.statusCode, b.statusCode];
    expect(codes).toContain(200);
    for (const code of codes) expect([200, 422]).toContain(code);
    const answered = [a, b].filter((r) => r.statusCode === 200).map((r) => dataOf<Adjust>(r));
    expect(answered.filter((r) => r.applied)).toHaveLength(1);
    expect(await adjustments(userId)).toBe(1);
    expect(await kit.balance(userId)).toBe(20_000n);
  });

  it('OPERATOR gets 404 for the action with a set and for its preview', async () => {
    const owner = await kit.session('OWNER');
    const operator = await kit.session('OPERATOR');
    const userId = await kit.user();
    await orderOf(t.db(), userId, 'HELD');
    const set = (await setOf(owner, userId, 1_000n)) ?? '';
    const res = await kit.post(operator, `users/${userId}/adjust-wallet`, {
      amountTiyin: '1000',
      reason: REASON,
      confirmOpenOrdersSet: set,
    });
    expect(res.statusCode).toBe(404);
    const preview = await t.request(
      'GET',
      `${API}/users/${userId}/adjust-preview?amountTiyin=1000`,
      t.spa({ cookie: operator.cookie }),
    );
    expect(preview.statusCode).toBe(404);
    expect(await adjustments(userId)).toBe(0);
  });
});
