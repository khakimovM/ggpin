import { LedgerItemSchema, type LedgerItem } from '@repo/shared';
import { useWalletE2e } from './wallet-e2e.helpers';

const e2e = useWalletE2e();
const T0 = new Date('2026-11-04T10:00:00.000Z').getTime();
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);

describe('GET /me/ledger', () => {
  it('requires a session', async () => {
    expect((await e2e.get('/me/ledger', null)).status).toBe(401);
  });

  it('matches the docs/04 example: item keys, order, string money, meta', async () => {
    const user = await e2e.newUser();
    const topup = await e2e.seedEntry(
      user.id,
      'TOPUP',
      2_034_100n,
      { refType: 'PAYMENT', refId: e2e.ref('cm3payment00000000000001') },
      at(5),
    );
    const purchase = await e2e.seedEntry(
      user.id,
      'PURCHASE',
      -550_000n,
      { refType: 'ORDER', refId: e2e.ref('cm3order00000000000000001') },
      at(12),
    );

    const res = await e2e.get('/me/ledger', user);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [
        {
          id: purchase,
          kind: 'PURCHASE',
          amountTiyin: '-550000',
          createdAt: at(12).toISOString(),
          orderId: e2e.ref('cm3order00000000000000001'),
          paymentId: null,
        },
        {
          id: topup,
          kind: 'TOPUP',
          amountTiyin: '2034100',
          createdAt: at(5).toISOString(),
          orderId: null,
          paymentId: e2e.ref('cm3payment00000000000001'),
        },
      ],
      meta: { page: 1, limit: 20, total: 2 },
    });
    for (const item of res.body.data as LedgerItem[]) {
      expect(LedgerItemSchema.safeParse(item).success).toBe(true);
      expect(Object.keys(item).sort()).toEqual(
        ['amountTiyin', 'createdAt', 'id', 'kind', 'orderId', 'paymentId'].sort(),
      );
    }
    expect(String(res.headers['cache-control'])).toContain('no-store');
  });

  it('orderId only for ORDER refs, paymentId only for PAYMENT refs; audit and referral ids stay hidden', async () => {
    const user = await e2e.newUser();
    await e2e.seedEntry(
      user.id,
      'REFUND',
      500n,
      { refType: 'ORDER', refId: e2e.ref('ord_1') },
      at(1),
    );
    await e2e.seedEntry(
      user.id,
      'TOPUP',
      900n,
      { refType: 'PAYMENT', refId: e2e.ref('pay_1') },
      at(2),
    );
    await e2e.seedEntry(
      user.id,
      'ADJUSTMENT',
      -100n,
      { refType: 'ADMIN_ACTION', refId: e2e.ref('audit_secret_1') },
      at(3),
    );
    await e2e.seedEntry(
      user.id,
      'REFERRAL_BONUS',
      50n,
      { refType: 'REFERRAL', refId: e2e.ref('ref_secret_1') },
      at(4),
    );

    const res = await e2e.get('/me/ledger', user);
    const byKind = new Map((res.body.data as LedgerItem[]).map((i) => [i.kind, i]));

    expect(byKind.get('REFUND')).toMatchObject({ orderId: e2e.ref('ord_1'), paymentId: null });
    expect(byKind.get('TOPUP')).toMatchObject({ orderId: null, paymentId: e2e.ref('pay_1') });
    expect(byKind.get('ADJUSTMENT')).toMatchObject({ orderId: null, paymentId: null });
    expect(byKind.get('REFERRAL_BONUS')).toMatchObject({ orderId: null, paymentId: null });
    expect(JSON.stringify(res.body)).not.toMatch(/audit_secret_1|ref_secret_1/);
  });

  it("returns only the caller's entries and counts only them (ownership)", async () => {
    const [a, b] = [await e2e.newUser(), await e2e.newUser()];
    const mine = await e2e.seedEntry(a.id, 'TOPUP', 10n, {
      refType: 'PAYMENT',
      refId: e2e.ref('iso_a'),
    });
    const theirs = await e2e.seedEntry(b.id, 'TOPUP', 20n, {
      refType: 'PAYMENT',
      refId: e2e.ref('iso_b'),
    });
    await e2e.seedEntry(b.id, 'TOPUP', 30n, { refType: 'PAYMENT', refId: e2e.ref('iso_b2') });

    const res = await e2e.get('/me/ledger', a);

    expect((res.body.data as LedgerItem[]).map((i) => i.id)).toEqual([mine]);
    expect(res.body.meta?.total).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(theirs);
    // there is no id in any route: another user's entry cannot even be asked for
    expect((await e2e.get(`/me/ledger/${theirs}`, a)).status).toBe(404);
  });

  it('filters by kind and counts the filtered rows', async () => {
    const user = await e2e.newUser();
    await e2e.seedEntry(
      user.id,
      'TOPUP',
      100n,
      { refType: 'PAYMENT', refId: e2e.ref('k_p1') },
      at(1),
    );
    await e2e.seedEntry(
      user.id,
      'TOPUP',
      200n,
      { refType: 'PAYMENT', refId: e2e.ref('k_p2') },
      at(2),
    );
    await e2e.seedEntry(
      user.id,
      'PURCHASE',
      -50n,
      { refType: 'ORDER', refId: e2e.ref('k_o1') },
      at(3),
    );

    const topups = await e2e.get('/me/ledger?kind=TOPUP', user);
    expect((topups.body.data as LedgerItem[]).map((i) => i.kind)).toEqual(['TOPUP', 'TOPUP']);
    expect(topups.body.meta).toEqual({ page: 1, limit: 20, total: 2 });

    const purchases = await e2e.get('/me/ledger?kind=PURCHASE', user);
    expect(purchases.body.meta?.total).toBe(1);

    const none = await e2e.get('/me/ledger?kind=REFUND', user);
    expect(none.body).toEqual({ success: true, data: [], meta: { page: 1, limit: 20, total: 0 } });
  });

  it('paginates newest first without overlap, and a page past the end is empty', async () => {
    const user = await e2e.newUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        await e2e.seedEntry(
          user.id,
          'TOPUP',
          BigInt(100 + i),
          { refType: 'PAYMENT', refId: e2e.ref(`pg_${String(i)}`) },
          at(i),
        ),
      );
    }
    const newestFirst = [...ids].reverse();

    const p1 = await e2e.get('/me/ledger?limit=2&page=1', user);
    const p2 = await e2e.get('/me/ledger?limit=2&page=2', user);
    const p3 = await e2e.get('/me/ledger?limit=2&page=3', user);
    const p4 = await e2e.get('/me/ledger?limit=2&page=4', user);

    const idsOf = (r: typeof p1): string[] => (r.body.data as LedgerItem[]).map((i) => i.id);
    expect([...idsOf(p1), ...idsOf(p2), ...idsOf(p3)]).toEqual(newestFirst);
    expect(p1.body.meta).toEqual({ page: 1, limit: 2, total: 5 });
    expect(idsOf(p4)).toEqual([]);
    expect(p4.body.meta).toEqual({ page: 4, limit: 2, total: 5 });
  });

  it('entries written in the same instant keep a stable order across pages', async () => {
    const user = await e2e.newUser();
    for (let i = 0; i < 4; i += 1) {
      await e2e.seedEntry(
        user.id,
        'TOPUP',
        1n,
        { refType: 'PAYMENT', refId: e2e.ref(`tie_${String(i)}`) },
        at(0),
      );
    }
    const all = [
      ...((await e2e.get('/me/ledger?limit=2&page=1', user)).body.data as LedgerItem[]),
      ...((await e2e.get('/me/ledger?limit=2&page=2', user)).body.data as LedgerItem[]),
    ].map((i) => i.id);
    expect(new Set(all).size).toBe(4);
  });

  it.each([
    ['limit above 100', '?limit=101'],
    ['limit zero', '?limit=0'],
    ['negative limit', '?limit=-1'],
    ['non-numeric limit', '?limit=abc'],
    ['page zero', '?page=0'],
    ['unknown kind', '?kind=BONUS'],
    ['lowercase kind', '?kind=topup'],
    ['unknown query key', '?userId=someone'],
  ])('%s -> 400 VALIDATION_ERROR', async (_name, query) => {
    const user = await e2e.newUser();
    const res = await e2e.get(`/me/ledger${query}`, user);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('limit=100 is the largest accepted page', async () => {
    const user = await e2e.newUser();
    const res = await e2e.get('/me/ledger?limit=100', user);
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, limit: 100, total: 0 });
  });
});
