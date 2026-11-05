import { OPERATOR, adminProbes } from './wallet-admin-e2e.shared';
import { useWalletE2e } from './wallet-e2e.helpers';

const e2e = useWalletE2e();
const { balanceOf, sumOf, frozenAlert } = adminProbes(e2e);

const BASE = 2_000_000n;
const AMOUNT = 2_012_300n; // BASE + the default 123 so'm suffix

describe('WalletAdminService.reverseTopup (real P2P_CARD shape, real database)', () => {
  it('writes TOPUP_REVERSAL, cancels the payment and audits in one go', async () => {
    const user = await e2e.newUser();
    const { paymentId } = await e2e.p2pPayment(user.id, { baseTiyin: BASE });
    expect(await balanceOf(user)).toBe(String(AMOUNT));

    const result = await e2e.admin().reverseTopup({
      paymentId,
      reason: 'card owner took the money back',
      ...OPERATOR,
    });

    expect(result).toMatchObject({
      applied: true,
      balanceTiyin: 0n,
      frozen: false,
      newlyFrozen: false,
      alertQueued: false,
    });
    const payment = await e2e.db().payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe('CANCELLED');
    expect(payment.cancelledAt).toBeInstanceOf(Date);
    const entry = await e2e
      .db()
      .ledgerEntry.findUniqueOrThrow({ where: { id: result.ledgerEntryId } });
    expect(entry).toMatchObject({
      kind: 'TOPUP_REVERSAL',
      amountTiyin: -AMOUNT,
      refType: 'PAYMENT',
      refId: paymentId,
    });
    const audit = await e2e.db().auditLog.findUniqueOrThrow({ where: { id: result.auditId } });
    expect(audit).toMatchObject({
      actorType: 'CLI',
      actorId: null,
      ip: '203.0.113.9',
      action: 'PAYMENT_REVERSE',
      targetType: 'Payment',
      targetId: paymentId,
      reason: 'card owner took the money back',
      before: { balanceTiyin: String(AMOUNT), paymentStatus: 'CONFIRMED' },
      after: {
        balanceTiyin: '0',
        paymentStatus: 'CANCELLED',
        reversedTiyin: String(AMOUNT),
        operator: 'e2e-owner',
      },
    });
    expect(await balanceOf(user)).toBe('0');
    expect((await e2e.db().user.findUniqueOrThrow({ where: { id: user.id } })).purchaseFrozen).toBe(
      false,
    );
  });

  it('the ledger amount wins over the payment row when they differ, and the audit says so', async () => {
    const user = await e2e.newUser();
    const credited = AMOUNT - 5_000n;
    const { paymentId } = await e2e.p2pPayment(user.id, {
      baseTiyin: BASE,
      creditedTiyin: credited,
    });

    const result = await e2e.admin().reverseTopup({ paymentId, reason: 'mismatch', ...OPERATOR });

    expect(result.balanceTiyin).toBe(0n);
    const audit = await e2e.db().auditLog.findUniqueOrThrow({ where: { id: result.auditId } });
    expect(audit.after).toMatchObject({ reversedTiyin: String(credited) });
    expect(await sumOf(user.id)).toBe(0n);
  });

  it('twice writes ONE reversal; the second call is a replay with the same ids', async () => {
    const user = await e2e.newUser();
    const { paymentId } = await e2e.p2pPayment(user.id, { baseTiyin: 100_000n });
    const input = { paymentId, reason: 'wrong payment', ...OPERATOR };

    const first = await e2e.admin().reverseTopup(input);
    const second = await e2e.admin().reverseTopup(input);

    expect(second).toMatchObject({
      applied: false,
      auditId: first.auditId,
      ledgerEntryId: first.ledgerEntryId,
      alertQueued: false,
    });
    expect(
      await e2e.db().ledgerEntry.count({ where: { userId: user.id, kind: 'TOPUP_REVERSAL' } }),
    ).toBe(1);
    expect(await e2e.db().auditLog.count({ where: { targetId: paymentId } })).toBe(1);
    expect(await sumOf(user.id)).toBe(0n);
  });

  it('a repeat with a different reason is a different request: IDEMPOTENCY_CONFLICT, nothing new', async () => {
    const user = await e2e.newUser();
    const { paymentId } = await e2e.p2pPayment(user.id, { baseTiyin: 100_000n });
    await e2e.admin().reverseTopup({ paymentId, reason: 'first reason', ...OPERATOR });

    await expect(
      e2e.admin().reverseTopup({ paymentId, reason: 'another reason', ...OPERATOR }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await e2e.db().auditLog.count({ where: { targetId: paymentId } })).toBe(1);
  });

  it('money already spent: balance negative, purchases frozen, one alert queued', async () => {
    const user = await e2e.newUser();
    const { paymentId } = await e2e.p2pPayment(user.id, { baseTiyin: BASE });
    await e2e.seedEntry(user.id, 'PURCHASE', -1_450_000n, {
      refType: 'ORDER',
      refId: e2e.ref('spent_1'),
    });

    const result = await e2e.admin().reverseTopup({ paymentId, reason: 'reversed', ...OPERATOR });

    expect(result).toMatchObject({
      balanceTiyin: -1_450_000n,
      frozen: true,
      newlyFrozen: true,
      alertQueued: true,
    });
    expect((await e2e.db().user.findUniqueOrThrow({ where: { id: user.id } })).purchaseFrozen).toBe(
      true,
    );
    expect(await frozenAlert(user.id, result.ledgerEntryId)).toBeDefined();
    expect(await balanceOf(user)).toBe('-1450000');
  });

  it('parallel reversals of one payment write exactly one entry', async () => {
    const user = await e2e.newUser();
    const { paymentId } = await e2e.p2pPayment(user.id, { baseTiyin: 100_000n });
    const run = (): ReturnType<ReturnType<typeof e2e.admin>['reverseTopup']> =>
      e2e.admin().reverseTopup({ paymentId, reason: 'race', ...OPERATOR });

    const results = await Promise.all([run(), run(), run(), run(), run()]);

    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(
      await e2e.db().ledgerEntry.count({ where: { userId: user.id, kind: 'TOPUP_REVERSAL' } }),
    ).toBe(1);
    expect(await sumOf(user.id)).toBe(0n);
  });

  it('parallel reversal + adjustments leave the ledger SUM exactly the sum of what was applied', async () => {
    const user = await e2e.newUser();
    const { paymentId } = await e2e.p2pPayment(user.id, { baseTiyin: 100_000n });
    const adjust = (amountTiyin: bigint): ReturnType<ReturnType<typeof e2e.admin>['adjust']> =>
      e2e.admin().adjust({ userId: user.id, amountTiyin, reason: 'mix', ...OPERATOR });

    const results = await Promise.all([
      e2e.admin().reverseTopup({ paymentId, reason: 'mix', ...OPERATOR }),
      adjust(300n),
      adjust(-50n),
      adjust(7n),
    ]);

    expect(results.every((r) => r.applied)).toBe(true);
    expect(await sumOf(user.id)).toBe(257n);
    // each change reported the balance it produced under the lock: all distinct, none lost
    expect(new Set(results.map((r) => r.balanceTiyin)).size).toBe(4);
    expect(await balanceOf(user)).toBe('257');
  });

  it('unknown payment -> NOT_FOUND; a payment that is not CONFIRMED is refused', async () => {
    await expect(
      e2e.admin().reverseTopup({ paymentId: 'no_such_payment', reason: 'x', ...OPERATOR }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const user = await e2e.newUser();
    const created = await e2e.clickPayment(user.id, 100n, 'CREATED');
    await expect(
      e2e.admin().reverseTopup({ paymentId: created, reason: 'x', ...OPERATOR }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await sumOf(user.id)).toBe(0n);
  });

  it('works for any provider, not only P2P_CARD', async () => {
    const user = await e2e.newUser();
    const paymentId = await e2e.clickPayment(user.id, 900n);
    await expect(
      e2e.admin().reverseTopup({ paymentId, reason: 'provider cancel', ...OPERATOR }),
    ).resolves.toMatchObject({ applied: true, balanceTiyin: 0n });
  });

  it('without a reason nothing changes', async () => {
    const user = await e2e.newUser();
    const { paymentId } = await e2e.p2pPayment(user.id, { baseTiyin: 100_000n });
    await expect(
      e2e.admin().reverseTopup({ paymentId, reason: ' ', ...OPERATOR }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await e2e.db().payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(
      'CONFIRMED',
    );
    expect(await sumOf(user.id)).toBe(112_300n);
  });

  it('a payment above the threshold needs its amount retyped; the refusal changes nothing', async () => {
    const user = await e2e.newUser();
    // threshold in the e2e env is the default 100 000 000 tiyin
    const { paymentId, amountTiyin } = await e2e.p2pPayment(user.id, {
      baseTiyin: 100_000_000n,
      suffixTiyin: 5_000n,
    });

    await expect(
      e2e.admin().reverseTopup({ paymentId, reason: 'large', ...OPERATOR }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await e2e.db().payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(
      'CONFIRMED',
    );
    expect(await sumOf(user.id)).toBe(amountTiyin);

    await expect(
      e2e.admin().reverseTopup({
        paymentId,
        reason: 'large',
        ...OPERATOR,
        confirmAmountTiyin: amountTiyin,
      }),
    ).resolves.toMatchObject({ applied: true, balanceTiyin: 0n });
  });

  it("another user's wallet is untouched by a reversal", async () => {
    const [a, b] = [await e2e.newUser(), await e2e.newUser()];
    await e2e.seedEntry(b.id, 'TOPUP', 777n, { refType: 'PAYMENT', refId: e2e.ref('bystander') });
    const { paymentId } = await e2e.p2pPayment(a.id, { baseTiyin: 100_000n });

    await e2e.admin().reverseTopup({ paymentId, reason: 'a only', ...OPERATOR });

    expect(await sumOf(a.id)).toBe(0n);
    expect(await sumOf(b.id)).toBe(777n);
    expect(await balanceOf(b)).toBe('777');
  });
});
