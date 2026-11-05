import { alertRef } from '@repo/shared';
import { OPERATOR, adminProbes } from './wallet-admin-e2e.shared';
import { useWalletE2e } from './wallet-e2e.helpers';

const e2e = useWalletE2e();
const { balanceOf, sumOf, frozenAlert } = adminProbes(e2e);

describe('WalletAdminService.adjust (real database)', () => {
  it('writes AuditLog + ADJUSTMENT(ADMIN_ACTION/<audit id>) together and drops the cached balance', async () => {
    const user = await e2e.newUser();
    await e2e.seedEntry(user.id, 'TOPUP', 1_000_000n, {
      refType: 'PAYMENT',
      refId: e2e.ref('adj_seed'),
    });
    expect(await balanceOf(user)).toBe('1000000'); // fills the cache
    expect(await e2e.redis().get(`wallet:${user.id}`)).toBe('1000000');

    const result = await e2e.admin().adjust({
      userId: user.id,
      amountTiyin: 250_000n,
      reason: 'compensation for a delayed order',
      ...OPERATOR,
    });

    expect(result).toMatchObject({
      applied: true,
      balanceTiyin: 1_250_000n,
      frozen: false,
      newlyFrozen: false,
      alertQueued: false,
    });
    const audit = await e2e.db().auditLog.findUniqueOrThrow({ where: { id: result.auditId } });
    expect(audit).toMatchObject({
      actorType: 'CLI',
      actorId: null,
      ip: '203.0.113.9',
      action: 'WALLET_ADJUST',
      targetType: 'User',
      targetId: user.id,
      reason: 'compensation for a delayed order',
      before: { balanceTiyin: '1000000' },
      after: { balanceTiyin: '1250000', operator: 'e2e-owner' },
    });
    const entry = await e2e
      .db()
      .ledgerEntry.findUniqueOrThrow({ where: { id: result.ledgerEntryId } });
    expect(entry).toMatchObject({
      userId: user.id,
      kind: 'ADJUSTMENT',
      amountTiyin: 250_000n,
      refType: 'ADMIN_ACTION',
      refId: result.auditId,
    });
    expect(await e2e.redis().get(`wallet:${user.id}`)).toBeNull();
    expect(await balanceOf(user)).toBe('1250000');
  });

  it('the same audit id twice writes ONE entry and ONE audit row; the second call is a replay', async () => {
    const user = await e2e.newUser();
    const auditId = `aud_${user.id.slice(0, 16)}`;
    const input = {
      userId: user.id,
      amountTiyin: 7_000n,
      reason: 'manual fix',
      ...OPERATOR,
      auditId,
    };

    const first = await e2e.admin().adjust(input);
    const second = await e2e.admin().adjust(input);

    expect(first).toMatchObject({ applied: true, auditId });
    expect(second).toMatchObject({
      applied: false,
      auditId,
      ledgerEntryId: first.ledgerEntryId,
      balanceTiyin: 7_000n,
    });
    expect(await e2e.db().ledgerEntry.count({ where: { userId: user.id } })).toBe(1);
    expect(await e2e.db().auditLog.count({ where: { id: auditId } })).toBe(1);
  });

  it('parallel runs of one command (same audit id) still write once', async () => {
    const user = await e2e.newUser();
    const auditId = `par_${user.id.slice(0, 16)}`;
    const run = (): ReturnType<ReturnType<typeof e2e.admin>['adjust']> =>
      e2e.admin().adjust({
        userId: user.id,
        amountTiyin: 100n,
        reason: 'race',
        ...OPERATOR,
        auditId,
      });

    const results = await Promise.all([run(), run(), run(), run()]);

    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await sumOf(user.id)).toBe(100n);
  });

  it('an audit id used for another user is refused (IDEMPOTENCY_CONFLICT), nothing written', async () => {
    const [a, b] = [await e2e.newUser(), await e2e.newUser()];
    const auditId = `cnf_${a.id.slice(0, 16)}`;
    await e2e.admin().adjust({ userId: a.id, amountTiyin: 5n, reason: 'x', ...OPERATOR, auditId });

    await expect(
      e2e.admin().adjust({ userId: b.id, amountTiyin: 5n, reason: 'x', ...OPERATOR, auditId }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await e2e.db().ledgerEntry.count({ where: { userId: b.id } })).toBe(0);
  });

  it('without a reason nothing is written (no audit row, no entry, balance unchanged)', async () => {
    const user = await e2e.newUser();
    const auditsBefore = await e2e.db().auditLog.count({ where: { targetId: user.id } });
    for (const reason of ['', '   ']) {
      await expect(
        e2e.admin().adjust({ userId: user.id, amountTiyin: 10n, reason, ...OPERATOR }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(await e2e.db().ledgerEntry.count({ where: { userId: user.id } })).toBe(0);
    expect(await e2e.db().auditLog.count({ where: { targetId: user.id } })).toBe(auditsBefore);
  });

  it('above ADMIN_CONFIRM_THRESHOLD_TIYIN it needs the amount retyped exactly', async () => {
    const user = await e2e.newUser();
    const big = 100_000_001n; // threshold in the e2e env is the default 100_000_000
    const base = { userId: user.id, amountTiyin: big, reason: 'large credit', ...OPERATOR };

    await expect(e2e.admin().adjust(base)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      e2e.admin().adjust({ ...base, confirmAmountTiyin: 100_000_000n }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await sumOf(user.id)).toBe(0n);

    await expect(e2e.admin().adjust({ ...base, confirmAmountTiyin: big })).resolves.toMatchObject({
      applied: true,
      balanceTiyin: big,
    });
  });

  it('a negative result freezes purchases and queues the walletFrozen alert after the commit', async () => {
    const user = await e2e.newUser();
    await e2e.seedEntry(user.id, 'TOPUP', 100n, { refType: 'PAYMENT', refId: e2e.ref('frz_seed') });

    const result = await e2e.admin().adjust({
      userId: user.id,
      amountTiyin: -600n,
      reason: 'chargeback',
      ...OPERATOR,
    });

    expect(result).toMatchObject({ balanceTiyin: -500n, frozen: true });
    const row = await e2e.db().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.purchaseFrozen).toBe(true);
    const job = await frozenAlert(user.id, result.ledgerEntryId);
    expect(job?.data).toEqual({
      kind: 'OWNER_ALERT',
      alert: 'walletFrozen',
      refId: alertRef.walletFrozen(user.id, result.ledgerEntryId),
    });
    expect(JSON.stringify(job?.data)).not.toContain('500'); // ids only, no amounts in Redis
    expect(await balanceOf(user)).toBe('-500');
  });

  it('a non-negative result leaves the user unfrozen and queues no alert', async () => {
    const user = await e2e.newUser();
    await e2e.seedEntry(user.id, 'TOPUP', 100n, { refType: 'PAYMENT', refId: e2e.ref('ok_seed') });
    const result = await e2e.admin().adjust({
      userId: user.id,
      amountTiyin: -100n,
      reason: 'exactly to zero',
      ...OPERATOR,
    });
    expect(result.frozen).toBe(false);
    expect((await e2e.db().user.findUniqueOrThrow({ where: { id: user.id } })).purchaseFrozen).toBe(
      false,
    );
    expect(await frozenAlert(user.id, result.ledgerEntryId)).toBeUndefined();
  });

  it('unknown user -> NOT_FOUND', async () => {
    await expect(
      e2e.admin().adjust({ userId: 'no_such_user', amountTiyin: 1n, reason: 'x', ...OPERATOR }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
