import { AppError } from '../../../common/exceptions/app-error';
import { WalletFrozenAlert } from '../wallet-frozen-alert';
import { WalletRepository } from '../wallet.repository';
import { OPERATOR, adminProbes } from './wallet-admin-e2e.shared';
import { useWalletE2e } from './wallet-e2e.helpers';

const e2e = useWalletE2e();
const { balanceOf, sumOf, frozenAlert } = adminProbes(e2e);

const adjustBody = (userId: string, auditId: string) => ({
  userId,
  amountTiyin: 7_000n,
  reason: 'manual fix',
  ...OPERATOR,
  auditId,
});

describe('adjust replay: the same auditId must carry the same request', () => {
  it.each([
    ['another amount', { amountTiyin: 7_001n }],
    ['another reason', { reason: 'something else' }],
  ])('%s -> IDEMPOTENCY_CONFLICT and nothing new is written', async (_name, override) => {
    const user = await e2e.newUser();
    const auditId = `rpl_${user.id.slice(0, 16)}`;
    await e2e.admin().adjust(adjustBody(user.id, auditId));

    await expect(
      e2e.admin().adjust({ ...adjustBody(user.id, auditId), ...override }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });

    expect(await e2e.db().ledgerEntry.count({ where: { userId: user.id } })).toBe(1);
    expect(await e2e.db().auditLog.count({ where: { id: auditId } })).toBe(1);
    expect(await sumOf(user.id)).toBe(7_000n);
  });

  it('another user -> IDEMPOTENCY_CONFLICT; the identical body is still a clean replay', async () => {
    const [a, b] = [await e2e.newUser(), await e2e.newUser()];
    const auditId = `rpu_${a.id.slice(0, 16)}`;
    await e2e.admin().adjust(adjustBody(a.id, auditId));

    await expect(e2e.admin().adjust(adjustBody(b.id, auditId))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await e2e.db().ledgerEntry.count({ where: { userId: b.id } })).toBe(0);
    await expect(e2e.admin().adjust(adjustBody(a.id, auditId))).resolves.toMatchObject({
      applied: false,
      balanceTiyin: 7_000n,
    });
  });

  it('parallel commands with one auditId for two users: one wins, the other is a conflict (no raw Prisma error)', async () => {
    const [a, b] = [await e2e.newUser(), await e2e.newUser()];
    const auditId = `rpp_${a.id.slice(0, 16)}`;

    const outcomes = await Promise.allSettled([
      e2e.admin().adjust(adjustBody(a.id, auditId)),
      e2e.admin().adjust(adjustBody(b.id, auditId)),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason: unknown = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(AppError);
    expect(reason).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await e2e.db().auditLog.count({ where: { id: auditId } })).toBe(1);
    expect((await sumOf(a.id)) + (await sumOf(b.id))).toBe(7_000n);
  });
});

describe('purchaseFrozen (D-41): reported as the DB flag, alert only on the flip', () => {
  const debit = (userId: string, amountTiyin: bigint) =>
    e2e.admin().adjust({ userId, amountTiyin, reason: 'chargeback', ...OPERATOR });

  it('first negative: flag set, one alert; the next debit does not alert again; a credit does not unfreeze', async () => {
    const user = await e2e.newUser();
    await e2e.seedEntry(user.id, 'TOPUP', 100n, { refType: 'PAYMENT', refId: e2e.ref('fz_seed') });

    const first = await debit(user.id, -600n);
    expect(first).toMatchObject({
      balanceTiyin: -500n,
      frozen: true,
      newlyFrozen: true,
      alertQueued: true,
    });
    expect(await frozenAlert(user.id, first.ledgerEntryId)).toBeDefined();

    const second = await debit(user.id, -50n);
    expect(second).toMatchObject({
      balanceTiyin: -550n,
      frozen: true,
      newlyFrozen: false,
      alertQueued: false,
    });
    expect(await frozenAlert(user.id, second.ledgerEntryId)).toBeUndefined();

    const credit = await e2e
      .admin()
      .adjust({ userId: user.id, amountTiyin: 10_000n, reason: 'top up by hand', ...OPERATOR });
    expect(credit).toMatchObject({
      balanceTiyin: 9_450n,
      frozen: true, // the debt is gone but the flag stays until the owner unfreezes (S8 CLI)
      newlyFrozen: false,
      alertQueued: false,
    });
    expect((await e2e.db().user.findUniqueOrThrow({ where: { id: user.id } })).purchaseFrozen).toBe(
      true,
    );
    expect(await frozenAlert(user.id, credit.ledgerEntryId)).toBeUndefined();
  });

  it('a flagged account whose balance is positive reports frozen on a replay too', async () => {
    const user = await e2e.newUser();
    await e2e.db().user.update({ where: { id: user.id }, data: { purchaseFrozen: true } });
    const auditId = `frp_${user.id.slice(0, 16)}`;
    await e2e.admin().adjust(adjustBody(user.id, auditId));
    await expect(e2e.admin().adjust(adjustBody(user.id, auditId))).resolves.toMatchObject({
      applied: false,
      frozen: true,
      newlyFrozen: false,
    });
  });

  it('an alert that cannot be queued: money stays committed, alertQueued false, newlyFrozen true', async () => {
    const user = await e2e.newUser();
    const spy = jest
      .spyOn(e2e.app().get(WalletFrozenAlert), 'raise')
      .mockRejectedValueOnce(new Error('redis down'));
    try {
      const result = await debit(user.id, -5n);
      expect(result).toMatchObject({
        applied: true,
        frozen: true,
        newlyFrozen: true,
        alertQueued: false,
      });
      expect(await sumOf(user.id)).toBe(-5n);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('operator and ip are validated before anything is opened', () => {
  it('an invisible character in the operator or a bad ip writes nothing', async () => {
    const user = await e2e.newUser();
    const before = await e2e.db().auditLog.count({ where: { targetId: user.id } });
    const body = { userId: user.id, amountTiyin: 5n, reason: 'ok' };
    await expect(e2e.admin().adjust({ ...body, operator: 'az​iz' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'operator' },
    });
    await expect(
      e2e.admin().adjust({ ...body, operator: 'aziz', ip: 'not-an-ip' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'ip' } });
    expect(await e2e.db().ledgerEntry.count({ where: { userId: user.id } })).toBe(0);
    expect(await e2e.db().auditLog.count({ where: { targetId: user.id } })).toBe(before);
  });
});

describe('rollback: a failing ledger write leaves no audit row and no state change', () => {
  it('adjust: appendEntry fails -> no AuditLog, balance and flag unchanged', async () => {
    const user = await e2e.newUser();
    const auditId = `rbk_${user.id.slice(0, 16)}`;
    const spy = jest
      .spyOn(e2e.app().get(WalletRepository), 'appendEntry')
      .mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(
        e2e.admin().adjust({ ...adjustBody(user.id, auditId), amountTiyin: -9_000n }),
      ).rejects.toThrow('disk full');
    } finally {
      spy.mockRestore();
    }
    expect(await e2e.db().auditLog.count({ where: { id: auditId } })).toBe(0);
    expect(await e2e.db().ledgerEntry.count({ where: { userId: user.id } })).toBe(0);
    expect((await e2e.db().user.findUniqueOrThrow({ where: { id: user.id } })).purchaseFrozen).toBe(
      false,
    );
    expect(await balanceOf(user)).toBe('0');
  });

  it('reverseTopup: appendEntry fails -> the Payment stays CONFIRMED, no AuditLog, no reversal', async () => {
    const user = await e2e.newUser();
    const { paymentId, amountTiyin } = await e2e.p2pPayment(user.id, { baseTiyin: 300_000n });
    const spy = jest
      .spyOn(e2e.app().get(WalletRepository), 'appendEntry')
      .mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(
        e2e.admin().reverseTopup({ paymentId, reason: 'will roll back', ...OPERATOR }),
      ).rejects.toThrow('disk full');
    } finally {
      spy.mockRestore();
    }

    const payment = await e2e.db().payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('CONFIRMED');
    expect(payment.cancelledAt).toBeNull();
    expect(await e2e.db().auditLog.count({ where: { targetId: paymentId } })).toBe(0);
    expect(
      await e2e.db().ledgerEntry.count({ where: { userId: user.id, kind: 'TOPUP_REVERSAL' } }),
    ).toBe(0);
    expect(await sumOf(user.id)).toBe(amountTiyin);

    // and the retry after the failure goes through cleanly
    await expect(
      e2e.admin().reverseTopup({ paymentId, reason: 'second try', ...OPERATOR }),
    ).resolves.toMatchObject({ applied: true, balanceTiyin: 0n });
  });
});
