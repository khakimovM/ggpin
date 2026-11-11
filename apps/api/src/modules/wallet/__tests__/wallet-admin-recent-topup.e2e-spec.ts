import { ownerCode } from '../../../common/admin/owner-otp/__tests__/owner-otp.testing';
import {
  adjustOtpFlags,
  adjustOtpTarget,
  RECENT_AUTO_TOPUP_WINDOW_MS,
  recentSetHash,
} from '../wallet-admin.input';
import type { AdjustWalletInput } from '../wallet-admin.types';
import { OPERATOR, adminProbes } from './wallet-admin-e2e.shared';
import { useWalletE2e } from './wallet-e2e.helpers';

// S9 round 3 (F-L1) on the real database: the matcher credited a transfer first, then the owner,
// not knowing it, is about to give the same money with wallet:adjust. A positive adjustment
// after an AUTOMATIC P2P top-up of the worker's auto-credit horizon (7 days, S9F-L2; Payment
// CONFIRMED, no review) writes nothing unless `confirmOverrideSet` is the id of the very set
// found under the wallet lock (S9F-L1, at any amount); AuditLog.after keeps the payment ids.
const e2e = useWalletE2e();
const { sumOf } = adminProbes(e2e);

/** The set id the CLI prints as recentAutoTopupSet: only the payment ids are hashed. */
const setOf = (...ids: string[]) =>
  recentSetHash(ids.map((id) => ({ id, amountTiyin: 0n, confirmedAt: null })));

const plus = (userId: string, amountTiyin: bigint, extra: Partial<AdjustWalletInput> = {}) =>
  e2e.admin().adjust({ userId, amountTiyin, reason: 'paid by hand', ...OPERATOR, ...extra });

describe('wallet:adjust after an automatic top-up (S9 F-L1)', () => {
  it('matcher first: a positive adjustment is refused and writes nothing', async () => {
    const user = await e2e.newUser();
    const { amountTiyin } = await e2e.p2pPayment(user.id, { baseTiyin: 500_000n });
    const audits = await e2e.db().auditLog.count({ where: { targetId: user.id } });
    await expect(plus(user.id, amountTiyin)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'user', reason: 'RECENT_AUTO_TOPUP' },
    });
    expect(await sumOf(user.id)).toBe(amountTiyin); // only the automatic TOPUP
    expect(await e2e.db().auditLog.count({ where: { targetId: user.id } })).toBe(audits);
  });

  it('with the set id it is written; AuditLog.after keeps the override and the payment id', async () => {
    const user = await e2e.newUser();
    const { paymentId, amountTiyin } = await e2e.p2pPayment(user.id, { baseTiyin: 500_000n });
    const done = await plus(user.id, 100_000n, { confirmOverrideSet: setOf(paymentId) });
    expect(done).toMatchObject({ applied: true, balanceTiyin: amountTiyin + 100_000n });
    const audit = await e2e.db().auditLog.findUniqueOrThrow({ where: { id: done.auditId } });
    expect(audit.after).toMatchObject({ override: true, recentAutoTopups: [paymentId] });
  });

  it('S9F-L1, below the threshold: a top-up after the refusal makes the old set id useless', async () => {
    const user = await e2e.newUser();
    const first = await e2e.p2pPayment(user.id, { baseTiyin: 500_000n });
    await expect(plus(user.id, 100_000n)).rejects.toMatchObject({
      details: { reason: 'RECENT_AUTO_TOPUP' },
    });
    const shown = setOf(first.paymentId); // what the refusal printed
    const second = await e2e.p2pPayment(user.id, { baseTiyin: 600_000n }); // M, credited meanwhile
    const before = await sumOf(user.id);
    await expect(plus(user.id, 100_000n, { confirmOverrideSet: shown })).rejects.toMatchObject({
      details: { field: 'user', reason: 'RECENT_AUTO_TOPUP' },
    });
    expect(await sumOf(user.id)).toBe(before);
    const fresh = setOf(first.paymentId, second.paymentId);
    const done = await plus(user.id, 100_000n, { confirmOverrideSet: fresh });
    expect(done.applied).toBe(true);
    const audit = await e2e.db().auditLog.findUniqueOrThrow({ where: { id: done.auditId } });
    const after = audit.after as { recentAutoTopups: string[] };
    expect([...after.recentAutoTopups].sort()).toEqual([first.paymentId, second.paymentId].sort());
  });

  it('a negative adjustment is not checked', async () => {
    const user = await e2e.newUser();
    const { amountTiyin } = await e2e.p2pPayment(user.id, { baseTiyin: 500_000n });
    const done = await plus(user.id, -100_000n);
    expect(done.balanceTiyin).toBe(amountTiyin - 100_000n);
    const audit = await e2e.db().auditLog.findUniqueOrThrow({ where: { id: done.auditId } });
    expect(audit.after).toMatchObject({ override: false, recentAutoTopups: [] });
  });

  it('a top-up older than the 7-day horizon, and one credited from a review, are not checked', async () => {
    const user = await e2e.newUser();
    const old = await e2e.p2pPayment(user.id, { baseTiyin: 500_000n });
    const longAgo = new Date(Date.now() - RECENT_AUTO_TOPUP_WINDOW_MS - 60_000);
    await e2e.db().payment.update({ where: { id: old.paymentId }, data: { confirmedAt: longAgo } });
    await expect(plus(user.id, 100_000n)).resolves.toMatchObject({ applied: true });
    // A Click payment is not the matcher's either.
    await e2e.clickPayment(user.id, 900n);
    await expect(plus(user.id, 100_000n)).resolves.toMatchObject({ applied: true });
  });

  it('the owner code is bound to the override (D-46): a code for "no override" does not do it', async () => {
    const user = await e2e.newUser();
    const { paymentId } = await e2e.p2pPayment(user.id, { baseTiyin: 500_000n });
    const big = 100_000_001n; // above the default e2e threshold (100 000 000)
    const scope = {
      action: 'wallet:adjust',
      amountTiyin: big,
      target: adjustOtpTarget(user.id, undefined),
    } as const;
    const plain = await ownerCode(e2e.app(), scope);
    const set = setOf(paymentId);
    await expect(
      plus(user.id, big, { confirmOverrideSet: set, confirmAmountTiyin: big, otp: plain }),
    ).rejects.toMatchObject({ details: { field: 'otp', reason: 'OTP_MISMATCH' } });
    const seen = [{ id: paymentId, amountTiyin: 0n, confirmedAt: null }];
    const flags = adjustOtpFlags(seen, true);
    const bound = await ownerCode(e2e.app(), { ...scope, flags });
    const done = await plus(user.id, big, {
      confirmOverrideSet: set,
      confirmAmountTiyin: big,
      otp: bound,
    });
    expect(done.applied).toBe(true);
    const audit = await e2e.db().auditLog.findUniqueOrThrow({ where: { id: done.auditId } });
    expect(audit.after).toMatchObject({ override: true, otpVerified: true });
  });
});
