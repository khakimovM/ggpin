import { Logger } from '@nestjs/common';
import { OPERATOR, auditDataOf, entry, entryByKind, payment, setup } from './wallet-admin.fixtures';

describe('reverseTopup guards', () => {
  const input = { paymentId: 'p1', reason: 'taken back', ...OPERATOR };

  it('the payment owner changed between the unlocked and the locked read -> INTERNAL_ERROR, nothing written', async () => {
    const { service, repo } = setup();
    repo.findPayment
      .mockResolvedValueOnce(payment({ userId: 'u1' }))
      .mockResolvedValueOnce(payment({ userId: 'u2' }));
    repo.findEntry.mockImplementation(entryByKind({ TOPUP: entry() }));
    await expect(service.reverseTopup(input)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(repo.cancelConfirmedPayment).not.toHaveBeenCalled();
    expect(repo.createAudit).not.toHaveBeenCalled();
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });

  it('credited amount differs from the payment row: ledger wins, audit has reversedTiyin, WARN has no amount', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service, repo } = setup(9_000_000n);
      repo.findPayment.mockResolvedValue(payment({ amountTiyin: 2_000_000n }));
      repo.findEntry.mockImplementation(entryByKind({ TOPUP: entry({ amountTiyin: 1_999_000n }) }));

      await service.reverseTopup(input);

      expect(repo.appendEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amountTiyin: -1_999_000n }),
      );
      expect(auditDataOf(repo)).toMatchObject({
        after: { reversedTiyin: '1999000' },
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0]);
      expect(logged).toContain('p1');
      expect(logged).not.toMatch(/1999000|2000000/);
    } finally {
      warn.mockRestore();
    }
  });

  it('equal amounts: no warning', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service, repo } = setup();
      repo.findPayment.mockResolvedValue(payment());
      repo.findEntry.mockImplementation(entryByKind({ TOPUP: entry() }));
      await service.reverseTopup(input);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a repeat with another reason is a different request -> IDEMPOTENCY_CONFLICT', async () => {
    const { service, repo } = setup();
    repo.findPayment.mockResolvedValue(payment({ status: 'CANCELLED' }));
    repo.findEntry.mockImplementation(
      entryByKind({ TOPUP_REVERSAL: entry({ id: 'e-rev', kind: 'TOPUP_REVERSAL' }) }),
    );
    repo.findAuditByTarget.mockResolvedValue({ id: 'audit-first', reason: 'taken back' });
    await expect(service.reverseTopup({ ...input, reason: 'other' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(service.reverseTopup(input)).resolves.toMatchObject({
      applied: false,
      auditId: 'audit-first',
    });
  });

  it('a reversal that drives an already frozen wallet further down does not alert again', async () => {
    const { service, repo, alert } = setup(100n);
    repo.findPayment.mockResolvedValue(payment());
    repo.findEntry.mockImplementation(entryByKind({ TOPUP: entry() }));
    repo.freezePurchases.mockResolvedValue(false);
    repo.isPurchaseFrozen.mockResolvedValue(true);
    await expect(service.reverseTopup(input)).resolves.toMatchObject({
      frozen: true,
      newlyFrozen: false,
      alertQueued: false,
    });
    expect(alert.raise).not.toHaveBeenCalled();
  });
});
