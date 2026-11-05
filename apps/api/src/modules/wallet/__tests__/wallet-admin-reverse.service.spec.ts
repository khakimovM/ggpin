import {
  OPERATOR,
  THRESHOLD,
  NOW,
  entry,
  entryByKind,
  payment,
  setup,
} from './wallet-admin.fixtures';

describe('WalletAdminService.reverseTopup', () => {
  const input = { paymentId: 'p1', reason: 'card owner took the money back', ...OPERATOR };

  it('unknown payment -> NOT_FOUND', async () => {
    const { service, repo } = setup();
    repo.findPayment.mockResolvedValue(null);
    await expect(service.reverseTopup(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reason is required (1..500)', async () => {
    const { service, repo } = setup();
    await expect(service.reverseTopup({ ...input, reason: '' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(repo.findPayment).not.toHaveBeenCalled();
  });

  it.each(['CREATED', 'CANCELLED'] as const)(
    'a %s payment without a reversal is refused',
    async (status) => {
      const { service, repo } = setup();
      repo.findPayment.mockResolvedValue(payment({ status }));
      repo.findEntry.mockImplementation(entryByKind({ TOPUP: entry() }));
      await expect(service.reverseTopup(input)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(repo.appendEntry).not.toHaveBeenCalled();
    },
  );

  it('CONFIRMED: reverses the credited amount, cancels the payment, audits, in one tx', async () => {
    const { service, repo, cache, alert } = setup(5_000_000n);
    repo.findPayment.mockResolvedValue(payment());
    repo.findEntry.mockImplementation(entryByKind({ TOPUP: entry() }));

    const result = await service.reverseTopup(input);

    expect(repo.lock).toHaveBeenCalledWith(expect.anything(), 'u1');
    expect(repo.cancelConfirmedPayment).toHaveBeenCalledWith(expect.anything(), 'p1', NOW);
    expect(repo.appendEntry).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u1',
      kind: 'TOPUP_REVERSAL',
      amountTiyin: -2_000_000n,
      refType: 'PAYMENT',
      refId: 'p1',
      note: input.reason,
    });
    expect(repo.createAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'PAYMENT_REVERSE',
        targetType: 'Payment',
        targetId: 'p1',
        before: { balanceTiyin: '5000000', paymentStatus: 'CONFIRMED' },
        after: {
          balanceTiyin: '3000000',
          paymentStatus: 'CANCELLED',
          reversedTiyin: '2000000',
          operator: 'aziz',
        },
      }),
    );
    expect(result).toMatchObject({ applied: true, balanceTiyin: 3_000_000n, frozen: false });
    expect(cache.invalidate).toHaveBeenCalledWith('u1');
    expect(alert.raise).not.toHaveBeenCalled();
  });

  it('money already spent: the balance goes negative, purchases freeze, the owner is alerted', async () => {
    const { service, repo, alert } = setup(1_450_000n);
    repo.findPayment.mockResolvedValue(payment());
    repo.findEntry.mockImplementation(entryByKind({ TOPUP: entry() }));

    const result = await service.reverseTopup(input);

    expect(result).toMatchObject({ balanceTiyin: -550_000n, frozen: true });
    expect(repo.freezePurchases).toHaveBeenCalledWith(expect.anything(), 'u1');
    expect(alert.raise).toHaveBeenCalledWith('u1', 'e-new');
  });

  it('a second call finds the TOPUP_REVERSAL: replay, nothing written, no alert', async () => {
    const { service, repo, cache, alert } = setup(-550_000n);
    repo.findPayment.mockResolvedValue(payment({ status: 'CANCELLED' }));
    repo.findEntry.mockImplementation(
      entryByKind({
        TOPUP: entry(),
        TOPUP_REVERSAL: entry({ id: 'e-rev', kind: 'TOPUP_REVERSAL', amountTiyin: -2_000_000n }),
      }),
    );
    repo.findAuditByTarget.mockResolvedValue({ id: 'audit-first', reason: input.reason });

    const result = await service.reverseTopup(input);

    expect(result).toMatchObject({
      applied: false,
      auditId: 'audit-first',
      ledgerEntryId: 'e-rev',
    });
    expect(repo.appendEntry).not.toHaveBeenCalled();
    expect(repo.createAudit).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(alert.raise).not.toHaveBeenCalled();
  });

  it('above the threshold the reversed amount must be retyped exactly', async () => {
    const { service, repo } = setup(THRESHOLD * 3n);
    const big = THRESHOLD + 5n;
    repo.findPayment.mockResolvedValue(payment({ amountTiyin: big }));
    repo.findEntry.mockImplementation(entryByKind({ TOPUP: entry({ amountTiyin: big }) }));

    await expect(service.reverseTopup(input)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'confirmAmountTiyin' },
    });
    await expect(
      service.reverseTopup({ ...input, confirmAmountTiyin: big - 1n }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repo.appendEntry).not.toHaveBeenCalled();
    expect(repo.cancelConfirmedPayment).not.toHaveBeenCalled();

    await expect(
      service.reverseTopup({ ...input, confirmAmountTiyin: big }),
    ).resolves.toMatchObject({ applied: true });
  });

  it('a CONFIRMED payment with no TOPUP entry is never reversed (no phantom debit)', async () => {
    const { service, repo } = setup();
    repo.findPayment.mockResolvedValue(payment());
    repo.findEntry.mockResolvedValue(null);
    await expect(service.reverseTopup(input)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });
});
