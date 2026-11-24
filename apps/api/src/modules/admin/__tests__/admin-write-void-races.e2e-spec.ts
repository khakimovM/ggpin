import { randomUUID } from 'node:crypto';
import { WalletRepository } from '../../wallet/wallet.repository';
import { adminAuditIdFor } from '../write/admin-write-key';
import { AdminWriteRepository } from '../write/admin-write.repository';
import { useAdminE2e } from './admin-e2e.harness';
import { waitForLockWaiter } from './admin-e2e.locks';
import { hook } from './admin-write-void.e2e-hook';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';
import type { Res } from './admin-e2e.api';

// 9-B SA-1, docs/04 «Idempotency-Key» (e): a void and an earlier request with the same key, with
// the interleaving forced by the test on real Postgres row locks. The key's audit id (primary
// key) decides: VOIDED (the earlier request never commits) or APPLIED, never a third outcome,
// and a request that lost never leaves a ledger entry or a state change behind.
const t = useAdminE2e();
const kit = adminWriteKit(t);
const writes = () => t.app().get(AdminWriteRepository);
const wallet = () => t.app().get(WalletRepository);
const REASON = 'void race adjustment';
const TOMBSTONE_INSERT = '%"AuditLog"%ON CONFLICT%';

const noDeadlockLogged = () => expect(t.logs.text()).not.toMatch(/40P01|deadlock/i);

const callVoid = (who: Session, key: string, userId: string, action = 'users.adjustWallet') =>
  kit.post(who, 'write-keys/void', { idempotencyKey: key, action, targetId: userId }, null);

const adjust = (who: Session, userId: string, key: string) =>
  kit.post(who, `users/${userId}/adjust-wallet`, { amountTiyin: '-500000', reason: REASON }, key);

async function fundedUser(): Promise<string> {
  const userId = await kit.user();
  await kit.payment(userId, 2_000_000n);
  return userId;
}

const adjustments = (userId: string) =>
  t.db().ledgerEntry.count({ where: { userId, kind: 'ADJUSTMENT' } });

describe('void vs an earlier request with the same key (real locks)', () => {
  it('the request committed first: APPLIED with its audit row, its ledger entry stays', async () => {
    const owner = await kit.session('OWNER');
    const userId = await fundedUser();
    const key = randomUUID();
    const done = await adjust(owner, userId, key);
    expect(done.statusCode).toBe(200);
    const { auditId } = dataOf<{ auditId: string }>(done);
    const res = await callVoid(owner, key, userId);
    expect(dataOf(res)).toMatchObject({ status: 'APPLIED', auditId, action: 'WALLET_ADJUST' });
    expect(await adjustments(userId)).toBe(1);
  });

  it('its audit row is inserted, not committed: the void waits; commit -> APPLIED', async () => {
    const owner = await kit.session('OWNER');
    const userId = await fundedUser();
    const key = randomUUID();
    const auditId = adminAuditIdFor(owner.admin.id, key);
    const state: { voiding?: Promise<Res>; waited: boolean } = { waited: false };
    const repo = wallet();
    const h = hook(repo, 'appendEntry', (original) => async (tx, entry) => {
      let settled = false;
      state.voiding = callVoid(owner, key, userId).finally(() => {
        settled = true;
      });
      state.waited = await waitForLockWaiter(t.db(), TOMBSTONE_INSERT, () => settled);
      return original(tx, entry);
    });
    const res = await adjust(owner, userId, key).finally(h.restore);
    if (state.voiding === undefined) throw new Error('the void never started');
    const voided = await state.voiding;

    expect(state.waited).toBe(true);
    expect(dataOf(res)).toMatchObject({ auditId, applied: true });
    expect(dataOf(voided)).toMatchObject({ status: 'APPLIED', auditId, action: 'WALLET_ADJUST' });
    expect(await adjustments(userId)).toBe(1);
    noDeadlockLogged();
  });

  it('its audit row is inserted, then it rolls back: the void goes in -> VOIDED, the request 409, no entry', async () => {
    const owner = await kit.session('OWNER');
    const userId = await fundedUser();
    const key = randomUUID();
    const auditId = adminAuditIdFor(owner.admin.id, key);
    const state: { voiding?: Promise<Res>; waited: boolean; failed: boolean } = {
      waited: false,
      failed: false,
    };
    const h1 = hook(wallet(), 'appendEntry', () => async () => {
      let settled = false;
      state.voiding = callVoid(owner, key, userId).finally(() => {
        settled = true;
      });
      state.waited = await waitForLockWaiter(t.db(), TOMBSTONE_INSERT, () => settled);
      state.failed = true;
      throw new Error('forced rollback after the audit insert');
    });
    // The runner reads the key's row again only after the work failed (CR nit #8: keyed on that
    // signal, not on a read count). Let the void commit first, so the answer is the tombstone's
    // 409 (else it may be the forced error's 500: both write nothing, only one is asserted).
    const h2 = hook(writes(), 'findAudit', (original) => async (id, db) => {
      if (id === auditId && db === undefined && state.failed) await state.voiding;
      return original(id, db);
    });
    const res = await adjust(owner, userId, key).finally(() => {
      h1.restore();
      h2.restore();
    });
    if (state.voiding === undefined) throw new Error('the void never started');
    const voided = await state.voiding;

    expect(state.waited).toBe(true);
    expect(dataOf(voided)).toMatchObject({ status: 'VOIDED', auditId });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await adjustments(userId)).toBe(0);
    const row = await t.db().auditLog.findUniqueOrThrow({ where: { id: auditId } });
    expect(row.action).toBe('IDEMPOTENCY_VOID');
    noDeadlockLogged();
  });

  it('adjust-wallet: the tombstone lands before its audit insert -> P2002, full rollback, 409, no entry', async () => {
    const owner = await kit.session('OWNER');
    const userId = await fundedUser();
    const key = randomUUID();
    const auditId = adminAuditIdFor(owner.admin.id, key);
    const voided: Res[] = [];
    // Under the wallet lock, all checks passed, the balance read: the void commits right then.
    const h = hook(wallet(), 'createAudit', (original) => async (tx, data) => {
      if (data.id === auditId) voided.push(await callVoid(owner, key, userId));
      return original(tx, data);
    });
    const res = await adjust(owner, userId, key).finally(h.restore);

    expect(voided.map((v) => dataOf(v))).toEqual([expect.objectContaining({ status: 'VOIDED' })]);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await adjustments(userId)).toBe(0);
    expect(await kit.balance(userId)).toBe(2_000_000n);
    // The same key and body later: still 409, still nothing.
    expect((await adjust(owner, userId, key)).statusCode).toBe(409);
    expect(await adjustments(userId)).toBe(0);
  });

  it('payment reverse: the payment was already CANCELLED in the transaction when the tombstone won -> rolled back too', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const paymentId = await kit.payment(userId, 300_000n);
    const key = randomUUID();
    const auditId = adminAuditIdFor(owner.admin.id, key);
    const voided: Res[] = [];
    const h = hook(wallet(), 'createAudit', (original) => async (tx, data) => {
      if (data.id === auditId) {
        voided.push(await callVoid(owner, key, paymentId, 'payments.reverse'));
      }
      return original(tx, data);
    });
    const res = await kit
      .post(owner, `payments/${paymentId}/reverse`, { reason: REASON }, key)
      .finally(h.restore);

    expect(voided.map((v) => dataOf(v))).toEqual([expect.objectContaining({ status: 'VOIDED' })]);
    expect(errorOf(res).code).toBe('IDEMPOTENCY_CONFLICT');
    const payment = await t.db().payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('CONFIRMED');
    const reversals = await t.db().ledgerEntry.count({
      where: { refType: 'PAYMENT', refId: paymentId, kind: 'TOPUP_REVERSAL' },
    });
    expect(reversals).toBe(0);
    expect(await kit.balance(userId)).toBe(300_000n);
  });

  it('the request has not reached its transaction: VOIDED, then its own insert fails -> 409, nothing changed', async () => {
    const owner = await kit.session('OPERATOR');
    const userId = await kit.user();
    const key = randomUUID();
    const auditId = adminAuditIdFor(owner.admin.id, key);
    const voided: Res[] = [];
    let runnerReads = 0;
    // The runner's first look (no row yet) is done; the void commits before the work starts.
    const h = hook(writes(), 'findAudit', (original) => async (id, db) => {
      const row = await original(id, db);
      if (id === auditId && db === undefined && ++runnerReads === 1) {
        voided.push(await callVoid(owner, key, userId, 'users.block'));
      }
      return row;
    });
    const res = await kit
      .post(owner, `users/${userId}/block`, { reason: REASON }, key)
      .finally(h.restore);

    expect(voided.map((v) => dataOf(v))).toEqual([expect.objectContaining({ status: 'VOIDED' })]);
    expect(errorOf(res).code).toBe('IDEMPOTENCY_CONFLICT');
    const user = await t.db().user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.isBlocked).toBe(false);
    expect(await t.db().auditLog.count({ where: { targetId: userId } })).toBe(1);
  });

  it('two voids of one key at once: both VOIDED, one tombstone', async () => {
    const owner = await kit.session('SUPPORT');
    const key = randomUUID();
    const [a, b] = await Promise.all([
      callVoid(owner, key, 'u1', 'users.note'),
      callVoid(owner, key, 'u1', 'users.note'),
    ]);
    const auditId = adminAuditIdFor(owner.admin.id, key);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(dataOf(a)).toMatchObject({ status: 'VOIDED', auditId });
    expect(dataOf(b)).toEqual(dataOf(a));
    expect(await t.db().auditLog.count({ where: { id: auditId } })).toBe(1);
  });
});
