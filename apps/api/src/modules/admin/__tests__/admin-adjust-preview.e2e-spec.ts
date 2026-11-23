import { randomUUID } from 'node:crypto';
import { AdminAdjustPreviewResponseSchema, type AdminAdjustPreview } from '@repo/shared';
import { createP2pPayment, retireCards } from '../../wallet/__tests__/wallet-p2p-fixture';
import { useAdminE2e } from './admin-e2e.harness';
import { orderOf } from './admin-open-orders.fixtures';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S7a: `GET /admin/users/:id/adjust-preview` (docs/04 «adjust-preview», Q3): OWNER only,
// the action's own reads in the contract shape, and its set ids carry the action past
// RECENT_AUTO_TOPUP and OPEN_ORDERS.
const t = useAdminE2e();
const kit = adminWriteKit(t);
const API = '/api/v1/admin';
const REASON = 'compensation after a held order check';

const preview = (who: Session, userId: string, amount: string) =>
  t.request(
    'GET',
    `${API}/users/${userId}/adjust-preview?amountTiyin=${amount}`,
    t.spa({ cookie: who.cookie }),
  );

const cards: string[] = [];
t.onClose(() => retireCards(t.db(), cards));

/** An automatic P2P top-up of the horizon (Payment CONFIRMED, no review) with its TOPUP entry. */
async function autoTopup(userId: string): Promise<{ paymentId: string; amountTiyin: bigint }> {
  const seed = (paymentId: string, amountTiyin: bigint) =>
    t.db().ledgerEntry.create({
      data: { userId, kind: 'TOPUP', amountTiyin, refType: 'PAYMENT', refId: paymentId },
    });
  return createP2pPayment(t.db(), seed, cards, userId, { baseTiyin: 2_000_000n });
}

describe('admin adjust-preview (S7a)', () => {
  it('OWNER gets the contract shape; OPERATOR, SUPPORT and no session get the unknown-route 404', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const ok = await preview(owner, userId, '-5000');
    expect(ok.statusCode).toBe(200);
    const view = AdminAdjustPreviewResponseSchema.parse(dataOf(ok));
    expect(view).toMatchObject({ balanceTiyin: '0', newBalanceTiyin: '-5000', otpRequired: false });
    expect(typeof view.manualCreditToday.capTiyin).toBe('string');

    const unknown = await t.request('GET', `${API}/no-such-route`, t.spa({ cookie: owner.cookie }));
    for (const role of ['OPERATOR', 'SUPPORT'] as const) {
      const who = await kit.session(role);
      const res = await preview(who, userId, '-5000');
      expect([role, res.statusCode, res.body]).toEqual([role, 404, unknown.body]);
    }
    const anonymous = await t.request(
      'GET',
      `${API}/users/${userId}/adjust-preview?amountTiyin=1`,
      t.spa(),
    );
    expect(anonymous.statusCode).toBe(404);
  });

  it('an unknown user is 404, the own account 400 SELF_TARGET, a bad amount 400', async () => {
    const owner = await kit.session('OWNER');
    expect((await preview(owner, 'cmnosuchuser000000000000001', '5')).statusCode).toBe(404);
    const own = await t.db().user.create({
      data: {
        telegramId: owner.admin.telegramId,
        firstName: 'Own',
        referralCode: `own${randomUUID().slice(0, 8)}`,
        wallet: { create: {} },
      },
      select: { id: true },
    });
    const self = await preview(owner, own.id, '5');
    expect(self.statusCode).toBe(400);
    expect(errorOf(self).details).toEqual([{ path: 'userId', code: 'SELF_TARGET' }]);
    const userId = await kit.user();
    for (const bad of ['0', '1.5', '100000000001', 'abc', '']) {
      expect([bad, (await preview(owner, userId, bad)).statusCode]).toEqual([bad, 400]);
    }
  });

  it('preview, then adjust with its sets: passes RECENT_AUTO_TOPUP and OPEN_ORDERS, money as strings', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const { paymentId, amountTiyin } = await autoTopup(userId);
    const order = await orderOf(t.db(), userId, 'HELD', 1_500_000n);
    const res = await preview(owner, userId, '100000');
    const view: AdminAdjustPreview = AdminAdjustPreviewResponseSchema.parse(dataOf(res));
    expect(view).toMatchObject({
      balanceTiyin: amountTiyin.toString(),
      newBalanceTiyin: (amountTiyin + 100_000n).toString(),
      otpRequired: true,
      otpReason: 'CREDIT',
      recentAutoTopups: [{ paymentId, amountTiyin: amountTiyin.toString() }],
      openOrders: [{ id: order.id, number: order.number, status: 'HELD', priceTiyin: '1500000' }],
    });
    expect(view.confirmOverrideSet).toMatch(/^[0-9a-f]{12}$/);
    expect(view.confirmOpenOrdersSet).toMatch(/^[0-9a-f]{12}$/);

    // The code and the action carry the two sets exactly as the preview gave them.
    const key = randomUUID();
    const sets = {
      confirmOverrideSet: view.confirmOverrideSet ?? '',
      confirmOpenOrdersSet: view.confirmOpenOrdersSet ?? '',
    };
    const otp = await kit.code(owner, {
      action: 'users.adjustWallet',
      targetId: userId,
      amountTiyin: '100000',
      ...sets,
      idempotencyKey: key,
    });
    const body = { amountTiyin: '100000', reason: REASON, confirmAmountTiyin: '100000', otp };
    const done = await kit.post(owner, `users/${userId}/adjust-wallet`, { ...body, ...sets }, key);
    expect(done.statusCode).toBe(200);
    const after = (amountTiyin + 100_000n).toString();
    expect(dataOf(done)).toMatchObject({ balanceTiyin: after, applied: true });
    expect(await kit.balance(userId)).toBe(amountTiyin + 100_000n);
  });

  it('otpRequired equals the confirmations decision (OTP_NOT_REQUIRED vs a code)', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    for (const amount of ['-5', '7', `-${(t.env.ADMIN_CONFIRM_THRESHOLD_TIYIN + 1n).toString()}`]) {
      const view = AdminAdjustPreviewResponseSchema.parse(
        dataOf(await preview(owner, userId, amount)),
      );
      const ask = await kit.post(
        owner,
        'confirmations',
        {
          action: 'users.adjustWallet',
          targetId: userId,
          amountTiyin: amount,
          idempotencyKey: randomUUID(),
        },
        null,
      );
      expect([amount, ask.statusCode]).toEqual([amount, view.otpRequired ? 201 : 400]);
    }
  });

  it('writes nothing', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const before = await t.db().auditLog.count({ where: { targetId: userId } });
    await preview(owner, userId, '5000');
    expect(await t.db().auditLog.count({ where: { targetId: userId } })).toBe(before);
    expect(await t.db().ledgerEntry.count({ where: { userId } })).toBe(0);
  });
});
