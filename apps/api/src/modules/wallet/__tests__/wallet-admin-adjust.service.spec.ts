import { WalletNotFoundError } from '@repo/db';
import { OPERATOR, THRESHOLD, entry, setup } from './wallet-admin.fixtures';

const adjustInput = {
  userId: 'u1',
  amountTiyin: 500_000n,
  reason: 'support credit',
  ...OPERATOR,
};

const OTP = { challengeId: '0'.repeat(32), code: '123456' };

describe('WalletAdminService.adjust: input rules (nothing is written on a rejection)', () => {
  it.each([
    ['empty reason', { reason: '' }],
    ['blank reason', { reason: '   ' }],
    ['reason of 501 characters', { reason: 'x'.repeat(501) }],
    ['reason with a control character', { reason: 'a\nb' }],
    ['zero amount', { amountTiyin: 0n }],
    ['amount beyond BIGINT', { amountTiyin: 2n ** 63n }],
    ['malformed user id', { userId: 'a b' }],
  ])('%s -> VALIDATION_ERROR', async (_name, override) => {
    const { service, repo } = setup();
    await expect(service.adjust({ ...adjustInput, ...override })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(repo.transaction).not.toHaveBeenCalled();
  });

  it('accepts a reason of exactly 1 and exactly 500 characters', async () => {
    const { service } = setup();
    await expect(service.adjust({ ...adjustInput, reason: 'x' })).resolves.toMatchObject({
      applied: true,
    });
    await expect(
      service.adjust({ ...adjustInput, reason: 'x'.repeat(500) }),
    ).resolves.toMatchObject({ applied: true });
  });

  it('above the threshold: no confirmation or a different one -> VALIDATION_ERROR', async () => {
    const { service, repo } = setup();
    const big = { ...adjustInput, amountTiyin: THRESHOLD + 1n };
    await expect(service.adjust(big)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'confirmAmountTiyin' },
    });
    await expect(service.adjust({ ...big, confirmAmountTiyin: THRESHOLD })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    // The sign matters: confirming the opposite direction is not a confirmation.
    await expect(
      service.adjust({ ...big, confirmAmountTiyin: -(THRESHOLD + 1n) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repo.transaction).not.toHaveBeenCalled();
  });

  it('above the threshold with the exact amount and the owner code: applied; a big debit needs it too', async () => {
    const { service, otp } = setup(THRESHOLD * 2n);
    const credit = { ...adjustInput, amountTiyin: THRESHOLD + 1n };
    // The re-typed amount alone is not enough (D-46).
    await expect(
      service.adjust({ ...credit, confirmAmountTiyin: THRESHOLD + 1n }),
    ).rejects.toMatchObject({ details: { field: 'otp', reason: 'OTP_REQUIRED' } });
    await expect(
      service.adjust({ ...credit, confirmAmountTiyin: THRESHOLD + 1n, otp: OTP }),
    ).resolves.toMatchObject({ applied: true });
    expect(otp.verifyIfGiven).toHaveBeenLastCalledWith(
      OTP,
      THRESHOLD + 1n,
      'wallet:adjust',
      'user u1 key -',
    );

    const debit = { ...adjustInput, amountTiyin: -(THRESHOLD + 1n) };
    await expect(service.adjust(debit)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      service.adjust({ ...debit, confirmAmountTiyin: -(THRESHOLD + 1n), otp: OTP }),
    ).resolves.toMatchObject({ applied: true });
  });

  it('exactly the threshold needs no confirmation', async () => {
    const { service } = setup();
    await expect(service.adjust({ ...adjustInput, amountTiyin: THRESHOLD })).resolves.toMatchObject(
      { applied: true },
    );
  });
});

describe('WalletAdminService.adjust: the transaction', () => {
  it('locks first, then audits with before/after, then writes ADJUSTMENT keyed by the audit id', async () => {
    const { service, repo, cache, alert } = setup(1_000_000n);
    const result = await service.adjust(adjustInput);

    const order = [repo.lock, repo.balance, repo.createAudit, repo.appendEntry].map(
      (m) => m.mock.invocationCallOrder[0],
    );
    expect(order).toEqual([...order].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(repo.createAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'WALLET_ADJUST',
        targetType: 'User',
        targetId: 'u1',
        before: { balanceTiyin: '1000000' },
        after: { balanceTiyin: '1500000', operator: 'aziz', osUser: null, otpVerified: false },
        reason: 'support credit',
        ip: '203.0.113.7',
      }),
    );
    expect(repo.appendEntry).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u1',
      kind: 'ADJUSTMENT',
      amountTiyin: 500_000n,
      refType: 'ADMIN_ACTION',
      refId: 'audit-1',
      note: 'support credit',
    });
    expect(result).toEqual({
      applied: true,
      userId: 'u1',
      auditId: 'audit-1',
      ledgerEntryId: 'e-new',
      balanceTiyin: 1_500_000n,
      frozen: false,
      newlyFrozen: false,
      alertQueued: false,
    });
    expect(repo.freezePurchases).not.toHaveBeenCalled();
    expect(alert.raise).not.toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalledWith('u1');
  });

  it('invalidates the cache only after the transaction callback has finished', async () => {
    const { service, repo, cache } = setup();
    let cacheCallsInsideTx = -1;
    repo.transaction.mockImplementation(async (fn) => {
      const out = await fn({});
      cacheCallsInsideTx = cache.invalidate.mock.calls.length;
      return out;
    });
    await service.adjust(adjustInput);
    expect(cacheCallsInsideTx).toBe(0);
    expect(cache.invalidate).toHaveBeenCalledTimes(1);
  });

  it('a negative result freezes purchases inside the tx and raises the alert after it', async () => {
    const { service, repo, alert } = setup(100_000n);
    const result = await service.adjust({ ...adjustInput, amountTiyin: -500_000n });
    expect(result).toMatchObject({ balanceTiyin: -400_000n, frozen: true });
    expect(repo.freezePurchases).toHaveBeenCalledWith(expect.anything(), 'u1');
    expect(alert.raise).toHaveBeenCalledWith('u1', 'e-new');
  });

  it('a result of exactly zero is not frozen', async () => {
    const { service, repo, alert } = setup(500_000n);
    const result = await service.adjust({ ...adjustInput, amountTiyin: -500_000n });
    expect(result.frozen).toBe(false);
    expect(repo.freezePurchases).not.toHaveBeenCalled();
    expect(alert.raise).not.toHaveBeenCalled();
  });

  it('a failing alert queue does not fail a committed correction', async () => {
    const { service, alert } = setup(0n);
    alert.raise.mockRejectedValue(new Error('redis down'));
    await expect(service.adjust({ ...adjustInput, amountTiyin: -1n })).resolves.toMatchObject({
      applied: true,
      frozen: true,
      newlyFrozen: true,
      alertQueued: false,
    });
  });

  it('a caller-chosen audit id that already exists is a replay: nothing written, no cache/alert', async () => {
    const { service, repo, cache, alert } = setup(3_000_000n);
    repo.findAudit.mockResolvedValue({
      id: 'audit-x',
      reason: 'support credit',
      action: 'WALLET_ADJUST',
      targetType: 'User',
      targetId: 'u1',
    });
    repo.findEntry.mockResolvedValue(
      entry({ id: 'e-first', kind: 'ADJUSTMENT', amountTiyin: 500_000n }),
    );

    const result = await service.adjust({ ...adjustInput, auditId: 'audit-x' });

    expect(result).toMatchObject({ applied: false, auditId: 'audit-x', ledgerEntryId: 'e-first' });
    expect(repo.createAudit).not.toHaveBeenCalled();
    expect(repo.appendEntry).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(alert.raise).not.toHaveBeenCalled();
  });

  it('an audit id that belongs to another user or action -> IDEMPOTENCY_CONFLICT', async () => {
    const { service, repo } = setup();
    repo.findAudit.mockResolvedValue({
      id: 'audit-x',
      reason: 'support credit',
      action: 'WALLET_ADJUST',
      targetType: 'User',
      targetId: 'someone-else',
    });
    await expect(service.adjust({ ...adjustInput, auditId: 'audit-x' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });

  it('unknown user (no wallet row) -> NOT_FOUND', async () => {
    const { service, repo } = setup();
    repo.lock.mockRejectedValue(new WalletNotFoundError('ghost'));
    await expect(service.adjust({ ...adjustInput, userId: 'ghost' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
