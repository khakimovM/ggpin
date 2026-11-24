import type { AdminActor } from '../../../common/admin/audit-actor';
import { checkedAdjustAmount } from '../wallet-admin.input';
import { THRESHOLD, entry, entryByKind, payment, setup } from './wallet-admin.fixtures';
import { OPEN_DEADLINE } from '../../../common/admin/__tests__/admin-deadline.fixture';

// The panel's own rules on the CLI's wallet services (S6 fix round): the codeless daily budget
// (SA-S6-3), no money to the admin's own account (SA-S6-9), ALREADY_REVERSED (C-4) and the
// adjustment bound (SA-S6-6). The CLI keeps its behaviour (other specs).

const actor = (permission: AdminActor['permission']): AdminActor => ({
  kind: 'ADMIN',
  adminId: 'a1',
  sessionId: 's1',
  ip: null,
  permission,
  request: { auditId: `a${'0'.repeat(63)}`, requestHash: 'h'.repeat(64) },
  deadline: OPEN_DEADLINE,
});

/** A tx whose raw reads answer by their SQL: the admin row, the budget usage, the own account. */
function panelTx(opts: { own?: boolean; usage?: { count: number; sumTiyin: bigint } } = {}) {
  return {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FOR SHARE')) {
        return Promise.resolve([{ id: 'a1', role: 'OWNER', isActive: true }]);
      }
      if (sql.includes('FROM "AuditLog"')) {
        return Promise.resolve([opts.usage ?? { count: 0, sumTiyin: 0n }]);
      }
      if (sql.includes('JOIN "AdminUser"')) return Promise.resolve(opts.own ? [{ one: 1 }] : []);
      return Promise.resolve([]);
    }),
    $executeRaw: jest.fn().mockResolvedValue(0),
    adminSession: {
      findUnique: jest.fn().mockResolvedValue({
        adminId: 'a1',
        revokedAt: null,
        expiresAt: new Date('2100-01-01T00:00:00.000Z'),
      }),
    },
  };
}

function panel(opts: Parameters<typeof panelTx>[0] = {}, balance = 5_000_000n) {
  const ctx = setup(balance);
  const tx = panelTx(opts);
  ctx.repo.transaction.mockImplementation((fn: (t: object) => Promise<unknown>) => fn(tx));
  return { ...ctx, tx };
}

const debit = (amountTiyin: bigint) => ({
  userId: 'u1',
  amountTiyin,
  reason: 'charge back by hand',
  actor: actor('users.adjustWallet'),
});

const OTP_REQUIRED = { details: { field: 'otp', reason: 'OTP_REQUIRED' } };

describe('panel codeless daily budget (SA-S6-3)', () => {
  it('the 10th codeless debit of the day passes, the 11th asks for the code', async () => {
    const ninth = panel({ usage: { count: 9, sumTiyin: 900n } });
    await expect(ninth.service.adjust(debit(-100n))).resolves.toMatchObject({ applied: true });
    // The budget lock was taken before the usage was read.
    expect(ninth.tx.$executeRaw).toHaveBeenCalled();

    const tenth = panel({ usage: { count: 10, sumTiyin: 1_000n } });
    await expect(tenth.service.adjust(debit(-100n))).rejects.toMatchObject(OTP_REQUIRED);
    expect(tenth.repo.appendEntry).not.toHaveBeenCalled();
  });

  it('exactly 2 000 000 som with this action passes, one tiyin more asks', async () => {
    const used = { count: 2, sumTiyin: 150_000_000n };
    const exact = panel({ usage: used });
    await expect(exact.service.adjust(debit(-50_000_000n))).resolves.toMatchObject({
      applied: true,
    });
    const over = panel({ usage: used });
    await expect(over.service.adjust(debit(-50_000_001n))).rejects.toMatchObject(OTP_REQUIRED);
  });

  it('a codeless reversal counts the same way', async () => {
    const { service, repo } = panel({ usage: { count: 10, sumTiyin: 0n } });
    repo.findPayment.mockResolvedValue(payment({ amountTiyin: 1_000n }));
    repo.findEntry.mockImplementation(entryByKind({ TOPUP: entry({ amountTiyin: 1_000n }) }));
    const reverse = { paymentId: 'p1', reason: 'reversed', actor: actor('payments.reverse') };
    await expect(service.reverseTopup(reverse)).rejects.toMatchObject(OTP_REQUIRED);
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });

  it('the CLI has no budget', async () => {
    const { service, repo } = setup();
    await expect(
      service.adjust({ userId: 'u1', amountTiyin: -THRESHOLD, reason: 'r1', operator: 'aziz' }),
    ).resolves.toMatchObject({ applied: true });
    expect(repo.codelessFlags).not.toHaveBeenCalled();
  });
});

describe('no money to the own account of the admin (SA-S6-9)', () => {
  it('an adjustment of the admin store account is SELF_TARGET, nothing written', async () => {
    const { service, repo } = panel({ own: true });
    await expect(service.adjust(debit(-100n))).rejects.toMatchObject({
      details: { field: 'userId', reason: 'SELF_TARGET' },
    });
    expect(repo.appendEntry).not.toHaveBeenCalled();
    expect(repo.createAudit).not.toHaveBeenCalled();
  });

  it('confirmTarget: unknown user 404 (C-10 a), own account SELF_TARGET', async () => {
    const { service, repo } = setup();
    repo.userExists.mockResolvedValueOnce(false);
    await expect(service.confirmTarget('a1', 'u1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    repo.isAdminsOwnUser.mockResolvedValueOnce(true);
    await expect(service.confirmTarget('a1', 'u1')).rejects.toMatchObject({
      details: { field: 'userId', reason: 'SELF_TARGET' },
    });
    await expect(service.confirmTarget('a1', 'u1')).resolves.toBeUndefined();
  });
});

describe('reversal by the panel (C-4, C-10 b)', () => {
  it('an already reversed payment is ALREADY_REVERSED for another key; nothing written', async () => {
    const { service, repo } = panel();
    repo.findPayment.mockResolvedValue(payment({ status: 'CANCELLED' }));
    repo.findEntry.mockImplementation(
      entryByKind({
        TOPUP: entry(),
        TOPUP_REVERSAL: entry({ id: 'e-rev', kind: 'TOPUP_REVERSAL', amountTiyin: -2_000_000n }),
      }),
    );
    const again = { paymentId: 'p1', reason: 'again', actor: actor('payments.reverse') };
    await expect(service.reverseTopup(again)).rejects.toMatchObject({
      details: { field: 'paymentStatus', reason: 'ALREADY_REVERSED' },
    });
    expect(repo.appendEntry).not.toHaveBeenCalled();
  });

  it('payment() gives the ledger TOPUP amount, not the payment row amount', async () => {
    const { service, repo } = setup();
    repo.findPayment.mockResolvedValue(payment({ amountTiyin: 9_999n }));
    repo.findEntry.mockImplementation(entryByKind({ TOPUP: entry({ amountTiyin: 5_000n }) }));
    await expect(service.payment('p1')).resolves.toEqual({ userId: 'u1', amountTiyin: 5_000n });
  });
});

describe('adjustment bound (SA-S6-6)', () => {
  it('1 000 000 000 som either way passes; one tiyin more is refused', () => {
    expect(checkedAdjustAmount(100_000_000_000n)).toBe(100_000_000_000n);
    expect(checkedAdjustAmount(-100_000_000_000n)).toBe(-100_000_000_000n);
    for (const bad of [100_000_000_001n, -100_000_000_001n, 0n]) {
      let thrown: unknown;
      try {
        checkedAdjustAmount(bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ details: { field: 'amountTiyin' } });
    }
  });
});
