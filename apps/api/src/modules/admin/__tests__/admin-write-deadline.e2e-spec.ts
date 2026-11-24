import { randomUUID } from 'node:crypto';
import { AdminAdjustWalletResponseSchema } from '@repo/shared';
import type { MonotonicClock } from '../../../common/admin/admin-deadline';
import { WalletRepository } from '../../wallet/wallet.repository';
import { adminAuditIdFor } from '../write/admin-write-key';
import { AdminWriteRepository } from '../write/admin-write.repository';
import { useAdminE2e } from './admin-e2e.harness';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';
import type { Res } from './admin-e2e.api';

// docs/04 «So‘rov deadline’i» (9-B M-1, owner decision 2026-11-23 Q3): an admin write past 45 s
// since it was received is `503 ADMIN_DEADLINE_EXCEEDED` with nothing written and its key still
// free; a committed key's replay answers whatever the clock says. The deadline's clock is
// injected: performance.now() plus an offset the test moves (the onRequest stamp stays on
// performance.now()), never the wall clock (WSL steps it).
const deadlineClock = { offsetMs: 0, nowMs: () => performance.now() + deadlineClock.offsetMs };
const monotonicClock: MonotonicClock = deadlineClock;
const t = useAdminE2e({ monotonicClock });
const kit = adminWriteKit(t);
const PAST_DEADLINE_MS = 46_000;
const REASON = 'paid by hand after a bank check';

const adjust = (owner: Session, userId: string, key: string) =>
  kit.post(owner, `users/${userId}/adjust-wallet`, { amountTiyin: '-500000', reason: REASON }, key);

const adjustments = (userId: string) =>
  t.db().ledgerEntry.count({ where: { userId, kind: 'ADJUSTMENT' } });
const auditRows = (owner: Session, key: string) =>
  t.db().auditLog.count({ where: { id: adminAuditIdFor(owner.admin.id, key) } });

function expectDeadlineRefusal(res: Res): void {
  expect(res.statusCode).toBe(503);
  expect(errorOf(res).code).toBe('ADMIN_DEADLINE_EXCEEDED');
  expect(res.json<{ error: { message: string } }>().error.message).toBe(
    'errors.ADMIN_DEADLINE_EXCEEDED',
  );
}

afterEach(() => {
  deadlineClock.offsetMs = 0;
  jest.restoreAllMocks();
});

describe('admin write request deadline (9-B M-1)', () => {
  it('point 1: past 45 s on arrival -> 503, no audit row, no ledger; the same key then applies', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await kit.payment(userId, 2_000_000n);
    const key = randomUUID();

    deadlineClock.offsetMs = PAST_DEADLINE_MS;
    expectDeadlineRefusal(await adjust(owner, userId, key));
    expect(await auditRows(owner, key)).toBe(0);
    expect(await adjustments(userId)).toBe(0);
    expect(await kit.balance(userId)).toBe(2_000_000n);

    deadlineClock.offsetMs = 0;
    const res = await adjust(owner, userId, key);
    expect(res.statusCode).toBe(200);
    expect(AdminAdjustWalletResponseSchema.parse(dataOf(res))).toMatchObject({ applied: true });
    expect(await adjustments(userId)).toBe(1);
    expect(await kit.balance(userId)).toBe(1_500_000n);
  });

  it('point 3: the deadline passes after the ledger row is written -> rollback, 503; the same key then applies', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await kit.payment(userId, 2_000_000n);
    const key = randomUUID();
    const wallet = t.app().get(WalletRepository);
    const append = wallet.appendEntry.bind(wallet);
    const spy = jest.spyOn(wallet, 'appendEntry').mockImplementation(async (tx, entry) => {
      const written = await append(tx, entry);
      deadlineClock.offsetMs = PAST_DEADLINE_MS; // inside the transaction, before its commit
      return written;
    });

    expectDeadlineRefusal(await adjust(owner, userId, key));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await adjustments(userId)).toBe(0);
    expect(await auditRows(owner, key)).toBe(0);
    expect(await kit.alerts('adminAction', adminAuditIdFor(owner.admin.id, key))).toBe(0);
    expect(await kit.balance(userId)).toBe(2_000_000n);

    spy.mockRestore();
    deadlineClock.offsetMs = 0;
    const res = await adjust(owner, userId, key);
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)).toMatchObject({ applied: true, balanceTiyin: '1500000' });
    expect(await adjustments(userId)).toBe(1);
  });

  it('a committed key replays whatever the clock says: 200, applied false, the same auditId', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await kit.payment(userId, 2_000_000n);
    const key = randomUUID();
    const first = await adjust(owner, userId, key);
    expect(first.statusCode).toBe(200);
    const done = AdminAdjustWalletResponseSchema.parse(dataOf(first));

    deadlineClock.offsetMs = 10 * 60_000;
    const replay = await adjust(owner, userId, key);
    expect(replay.statusCode).toBe(200);
    expect(dataOf(replay)).toMatchObject({
      auditId: done.auditId,
      ledgerEntryId: done.ledgerEntryId,
      applied: false,
    });
    expect(await adjustments(userId)).toBe(1);
  });

  it('the void path: past the deadline -> 503 and no tombstone; within it the void answers', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const key = randomUUID();
    const body = { idempotencyKey: key, action: 'users.adjustWallet', targetId: userId };

    deadlineClock.offsetMs = PAST_DEADLINE_MS;
    expectDeadlineRefusal(await kit.post(owner, 'write-keys/void', body, null));
    expect(await auditRows(owner, key)).toBe(0);

    deadlineClock.offsetMs = 0;
    const voided = await kit.post(owner, 'write-keys/void', body, null);
    expect(voided.statusCode).toBe(200);
    expect(dataOf(voided)).toMatchObject({ status: 'VOIDED' });
  });

  it('the void path, before the commit: the tombstone rolls back -> 503; the same key then voids', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const key = randomUUID();
    const body = { idempotencyKey: key, action: 'users.adjustWallet', targetId: userId };
    const writes = t.app().get(AdminWriteRepository);
    const insert = writes.insertTombstone.bind(writes);
    const spy = jest.spyOn(writes, 'insertTombstone').mockImplementation(async (tx, tombstone) => {
      const inserted = await insert(tx, tombstone);
      deadlineClock.offsetMs = PAST_DEADLINE_MS; // the tombstone is in, the commit not yet
      return inserted;
    });

    expectDeadlineRefusal(await kit.post(owner, 'write-keys/void', body, null));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await auditRows(owner, key)).toBe(0);

    spy.mockRestore();
    deadlineClock.offsetMs = 0;
    const voided = await kit.post(owner, 'write-keys/void', body, null);
    expect(voided.statusCode).toBe(200);
    expect(dataOf(voided)).toMatchObject({
      status: 'VOIDED',
      auditId: adminAuditIdFor(owner.admin.id, key),
    });
    expect(await auditRows(owner, key)).toBe(1);
  });

  it('a credit with its code, 503 before the commit: the used code is CODE_EXPIRED, a new code with the same key applies once', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const key = randomUUID();
    const amount = '250000';
    const newCode = () =>
      kit.code(owner, {
        action: 'users.adjustWallet',
        targetId: userId,
        amountTiyin: amount,
        idempotencyKey: key,
      });
    const path = `users/${userId}/adjust-wallet`;
    const body = { amountTiyin: amount, reason: REASON, confirmAmountTiyin: amount };
    const wallet = t.app().get(WalletRepository);
    const append = wallet.appendEntry.bind(wallet);
    const spy = jest.spyOn(wallet, 'appendEntry').mockImplementation(async (tx, entry) => {
      const written = await append(tx, entry);
      deadlineClock.offsetMs = PAST_DEADLINE_MS;
      return written;
    });

    const otp = await newCode();
    expectDeadlineRefusal(await kit.post(owner, path, { ...body, otp }, key));
    expect(await adjustments(userId)).toBe(0);
    expect(await auditRows(owner, key)).toBe(0);

    spy.mockRestore();
    deadlineClock.offsetMs = 0;
    // The code was used before the transaction: the same code again is refused, nothing written.
    const stale = await kit.post(owner, path, { ...body, otp }, key);
    expect(stale.statusCode).toBe(422);
    expect(errorOf(stale).code).toBe('CODE_EXPIRED');
    expect(await adjustments(userId)).toBe(0);

    const fresh = await kit.post(owner, path, { ...body, otp: await newCode() }, key);
    expect(fresh.statusCode).toBe(200);
    expect(dataOf(fresh)).toMatchObject({ applied: true, balanceTiyin: amount });
    expect(await adjustments(userId)).toBe(1);
    expect(await kit.balance(userId)).toBe(250_000n);
  });
});
