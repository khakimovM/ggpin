import { OPERATOR, auditDataOf, entry, entryByKind, payment, setup } from './wallet-admin.fixtures';

const base = { userId: 'u1', amountTiyin: 500_000n, reason: 'support credit', ...OPERATOR };

describe('audit actor (docs/03, docs/05 section 9)', () => {
  it('adjust: the operator goes to after.operator; the audit data carries no actor id', async () => {
    const { service, repo } = setup();
    await service.adjust({ ...base, operator: 'Aziz Khakimov' });
    const data = auditDataOf(repo);
    expect(data['after']).toMatchObject({ operator: 'Aziz Khakimov' });
    expect(data).not.toHaveProperty('actorId');
    expect(data).not.toHaveProperty('actorType'); // the repository fixes it to CLI
  });

  it('reverseTopup: the operator goes to after.operator too', async () => {
    const { service, repo } = setup();
    repo.findPayment.mockResolvedValue(payment());
    repo.findEntry.mockImplementation(entryByKind({ TOPUP: entry() }));
    await service.reverseTopup({ paymentId: 'p1', reason: 'r1', ...OPERATOR });
    expect(auditDataOf(repo)).toMatchObject({
      after: { operator: 'aziz', reversedTiyin: '2000000', paymentStatus: 'CANCELLED' },
    });
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['leading space', ' aziz'],
    ['trailing space', 'aziz '],
    ['double space', 'a  b'],
    ['tab', 'a\tb'],
    ['newline', 'a\nb'],
    ['zero-width space', 'az​iz'],
    ['bidi override', 'aziz‮txt'],
    ['65 characters', 'x'.repeat(65)],
  ])('operator %s -> VALIDATION_ERROR, nothing opened', async (_name, operator) => {
    const { service, repo } = setup();
    await expect(service.adjust({ ...base, operator })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'operator' },
    });
    expect(repo.transaction).not.toHaveBeenCalled();
  });

  it.each(['aziz', 'a.khakimov@ggpin.uz', 'Азиз Хакимов', 'x'.repeat(64)])(
    'operator %s is accepted',
    async (operator) => {
      const { service } = setup();
      await expect(service.adjust({ ...base, operator })).resolves.toMatchObject({ applied: true });
    },
  );

  it.each(['not-an-ip', '999.1.1.1', '1.2.3', ' 1.2.3.4', '1.2.3.4\n', '<script>'])(
    'ip %s -> VALIDATION_ERROR',
    async (ip) => {
      const { service, repo } = setup();
      await expect(service.adjust({ ...base, ip })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { field: 'ip' },
      });
      expect(repo.transaction).not.toHaveBeenCalled();
    },
  );

  it.each(['203.0.113.7', '2001:db8::1', null, undefined])('ip %s is accepted', async (ip) => {
    const { service, repo } = setup();
    await service.adjust({ ...base, ip });
    expect(auditDataOf(repo)).toMatchObject({ ip: ip ?? null });
  });
});

describe('reason must be visible text with a letter or digit', () => {
  it.each([
    ['zero-width space', 'fix​it'],
    ['bidi override', 'fix‮ti'],
    ['zero-width joiner', 'a‍b'],
    ['line separator', 'a b'],
    ['punctuation only', '...'],
    ['symbols only', '-- !!'],
    ['emoji only', '\u{1F600}'],
    ['control character', 'a\u0007b'],
  ])('%s -> VALIDATION_ERROR on adjust and reverseTopup', async (_name, reason) => {
    const { service, repo } = setup();
    await expect(service.adjust({ ...base, reason })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'reason' },
    });
    await expect(
      service.reverseTopup({ paymentId: 'p1', reason, ...OPERATOR }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'reason' } });
    expect(repo.transaction).not.toHaveBeenCalled();
  });

  it.each(['123', 'chargeback #7', 'Qaytarish: noto‘g‘ri to‘lov', 'Возврат платежа', 'a'])(
    '%s is accepted',
    async (reason) => {
      const { service } = setup();
      await expect(service.adjust({ ...base, reason })).resolves.toMatchObject({ applied: true });
    },
  );
});

describe('adjust replay: same auditId must mean the same request', () => {
  const stored = {
    id: 'audit-x',
    reason: 'support credit',
    action: 'WALLET_ADJUST',
    targetType: 'User',
    targetId: 'u1',
  };

  function replaySetup(overrides: Partial<typeof stored> = {}, amountTiyin = 500_000n) {
    const ctx = setup(3_000_000n);
    ctx.repo.findAudit.mockResolvedValue({ ...stored, ...overrides });
    ctx.repo.findEntry.mockResolvedValue(entry({ id: 'e-first', kind: 'ADJUSTMENT', amountTiyin }));
    return ctx;
  }

  it('identical body -> applied:false with the first run ids, nothing written', async () => {
    const { service, repo, alert, cache } = replaySetup();
    const result = await service.adjust({ ...base, auditId: 'audit-x' });
    expect(result).toMatchObject({
      applied: false,
      auditId: 'audit-x',
      ledgerEntryId: 'e-first',
      newlyFrozen: false,
      alertQueued: false,
    });
    expect(repo.appendEntry).not.toHaveBeenCalled();
    expect(repo.createAudit).not.toHaveBeenCalled();
    expect(alert.raise).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['another amount', { amountTiyin: 500_001n }],
    ['another reason', { reason: 'something else' }],
    ['another user', { userId: 'u2' }],
  ])('%s -> IDEMPOTENCY_CONFLICT, nothing written', async (_name, override) => {
    const { service, repo } = replaySetup();
    // The lookup is by audit id, so the mocked stored audit always belongs to u1.
    await expect(
      service.adjust({ ...base, ...override, auditId: 'audit-x' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    expect(repo.appendEntry).not.toHaveBeenCalled();
    expect(repo.createAudit).not.toHaveBeenCalled();
  });

  it('the stored audit is another action -> IDEMPOTENCY_CONFLICT', async () => {
    const { service } = replaySetup({ action: 'PAYMENT_REVERSE' });
    await expect(service.adjust({ ...base, auditId: 'audit-x' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('the stored ledger amount differs from the request (audit text equal) -> IDEMPOTENCY_CONFLICT', async () => {
    const { service } = replaySetup({}, 123n);
    await expect(service.adjust({ ...base, auditId: 'audit-x' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('the replay reports the flag as it is now, not as it was', async () => {
    const { service, repo } = replaySetup();
    repo.isPurchaseFrozen.mockResolvedValue(true);
    await expect(service.adjust({ ...base, auditId: 'audit-x' })).resolves.toMatchObject({
      applied: false,
      frozen: true,
      newlyFrozen: false,
    });
  });

  it('a unique violation on the audit id (parallel commands, different users) -> IDEMPOTENCY_CONFLICT', async () => {
    const { service, repo } = setup();
    repo.createAudit.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(service.adjust({ ...base, auditId: 'audit-x' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });

  it('any other audit error is not disguised as a conflict', async () => {
    const { service, repo } = setup();
    const boom = new Error('connection lost');
    repo.createAudit.mockRejectedValue(boom);
    await expect(service.adjust(base)).rejects.toBe(boom);
  });
});

describe('purchaseFrozen is reported as the flag and alerts only on the flip (D-41)', () => {
  const debit = { ...base, amountTiyin: -600_000n };

  it('first negative: flag flips, alert queued, alertQueued true', async () => {
    const { service, alert } = setup(100_000n);
    const result = await service.adjust(debit);
    expect(result).toMatchObject({ frozen: true, newlyFrozen: true, alertQueued: true });
    expect(alert.raise).toHaveBeenCalledTimes(1);
  });

  it('already frozen and still negative: no flip, no second alert, frozen stays true', async () => {
    const { service, repo, alert } = setup(-100_000n);
    repo.freezePurchases.mockResolvedValue(false);
    repo.isPurchaseFrozen.mockResolvedValue(true);
    const result = await service.adjust(debit);
    expect(result).toMatchObject({ frozen: true, newlyFrozen: false, alertQueued: false });
    expect(alert.raise).not.toHaveBeenCalled();
  });

  it('a credit that clears the debt does NOT unfreeze: frozen is the DB flag, not balance < 0', async () => {
    const { service, repo, alert } = setup(-100_000n);
    repo.isPurchaseFrozen.mockResolvedValue(true);
    const result = await service.adjust({ ...base, amountTiyin: 900_000n });
    expect(result).toMatchObject({ balanceTiyin: 800_000n, frozen: true, newlyFrozen: false });
    expect(repo.freezePurchases).not.toHaveBeenCalled();
    expect(alert.raise).not.toHaveBeenCalled();
    // and nothing in the service ever writes purchaseFrozen=false
    expect(Object.keys(repo).filter((k) => /unfreeze/i.test(k))).toEqual([]);
  });

  it('an enqueue failure: committed anyway, alertQueued false, newlyFrozen tells the CLI to warn', async () => {
    const { service, alert } = setup(0n);
    alert.raise.mockRejectedValue(new Error('redis down'));
    await expect(service.adjust(debit)).resolves.toMatchObject({
      applied: true,
      newlyFrozen: true,
      alertQueued: false,
    });
  });
});
