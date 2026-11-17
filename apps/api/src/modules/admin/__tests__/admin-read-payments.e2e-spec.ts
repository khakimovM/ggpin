import { useAdminE2e } from './admin-e2e.harness';
import { buildReadWorld, RAW_PAN, TOPUP_TIYIN, type ReadWorld } from './admin-read.fixtures';
import { leaks } from './admin-read.scan';
import { checkRead } from './admin-read.schemas';

const A = '/api/v1/admin';
type Row = Record<string, unknown>;
type Body = { data: Row | Row[]; meta?: Record<string, number> };

// GET /admin/payments*: the raw bank text, the balance after it and the channel are the OWNER's
// only; no route ever returns a full card number, a provider reference or a raw payload.
describe('admin read: payments (real app)', () => {
  const t = useAdminE2e();
  let w: ReadWorld;
  let owner = '';
  let operator = '';
  let support = '';

  beforeAll(async () => {
    w = await buildReadWorld(t.db(), new Date(Date.now() - 3_600_000));
    owner = (await t.login(await t.newAdmin('OWNER'))).cookie;
    operator = (await t.login(await t.newAdmin('OPERATOR'))).cookie;
    support = (await t.login(await t.newAdmin('SUPPORT'))).cookie;
  });

  const get = async (url: string, cookie = owner) => {
    const res = await t.request('GET', url, t.spa({ cookie }));
    checkRead(url, res.statusCode, res.json());
    return { status: res.statusCode, body: res.json<Body>(), text: res.body };
  };
  const rows = (body: Body): Row[] => (Array.isArray(body.data) ? body.data : []);
  const one = (body: Body): Row => (Array.isArray(body.data) ? {} : body.data);

  it('bank message: OWNER reads the raw text; OPERATOR and SUPPORT get nulls', async () => {
    const url = `${A}/payments/bank-messages/${w.messageId}`;
    const full = await get(url, owner);
    expect(one(full.body)).toMatchObject({
      id: w.messageId,
      amountTiyin: TOPUP_TIYIN.toString(),
      balanceAfterTiyin: '777000000',
      channel: 'P2P',
      last4: w.last4,
    });
    expect(String(one(full.body)['text'])).toContain('Popolnenie');
    expect(leaks(full.body, ['$.data.text'])).toEqual([]);
    for (const cookie of [operator, support]) {
      const res = await get(url, cookie);
      expect(res.status).toBe(200);
      expect(one(res.body)).toMatchObject({ text: null, balanceAfterTiyin: null, channel: null });
      expect(res.text).not.toContain(RAW_PAN);
      expect(res.text).not.toContain('Popolnenie');
      expect(leaks(res.body)).toEqual([]);
    }
  });

  it('review detail: the nested bank message follows the same rule', async () => {
    const url = `${A}/payments/reviews/${w.reviewId}`;
    const full = await get(url, owner);
    expect(one(full.body)).toMatchObject({ id: w.reviewId, kind: 'NO_MATCH', status: 'OPEN' });
    expect(String((one(full.body)['bankMessage'] as Row)['text'])).toContain(RAW_PAN);
    for (const cookie of [operator, support]) {
      const res = await get(url, cookie);
      expect((one(res.body)['bankMessage'] as Row)['text']).toBeNull();
      expect(res.text).not.toContain(RAW_PAN);
      expect(leaks(res.body)).toEqual([]);
    }
  });

  it('lists: filters, money as strings, limit 101 is 400, nothing secret', async () => {
    const intents = await get(`${A}/payments/intents?userId=${w.user.id}`, support);
    expect(rows(intents.body)).toHaveLength(1);
    expect(rows(intents.body)[0]).toMatchObject({
      id: w.intentId,
      amountTiyin: TOPUP_TIYIN.toString(),
    });
    const payments = await get(`${A}/payments?userId=${w.user.id}&status=CONFIRMED`, support);
    expect(rows(payments.body)).toMatchObject([
      { id: w.paymentId, amountTiyin: TOPUP_TIYIN.toString() },
    ]);
    expect(rows((await get(`${A}/payments?userId=${w.user.id}&status=CANCELLED`)).body)).toEqual(
      [],
    );
    const reviews = await get(`${A}/payments/reviews?cardId=${w.cardId}`, support);
    expect(rows(reviews.body)).toMatchObject([{ id: w.reviewId, amountTiyin: '3000000' }]);
    const resolved = await get(`${A}/payments/reviews?cardId=${w.cardId}&status=RESOLVED`);
    expect(rows(resolved.body)).toEqual([]);
    for (const path of ['payments/intents', 'payments', 'payments/reviews', 'payments/reconcile']) {
      expect([path, (await get(`${A}/${path}?limit=101`)).status]).toEqual([path, 400]);
      expect([path, (await get(`${A}/${path}?limit=100`)).status]).toEqual([path, 200]);
      for (const cookie of [owner, support]) {
        expect([path, leaks((await get(`${A}/${path}`, cookie)).body)]).toEqual([path, []]);
      }
    }
  });

  it('cards: bank and last four, never the number; every role', async () => {
    for (const cookie of [owner, operator, support]) {
      const res = await get(`${A}/payments/cards`, cookie);
      const card = rows(res.body).find((row) => row['id'] === w.cardId);
      expect(card).toMatchObject({ bank: 'HUMO', last4: w.last4, status: 'RETIRED' });
      expect(Object.keys(card ?? {})).not.toContain('pan');
      expect(leaks(res.body)).toEqual([]);
    }
  });

  it('credit preview (OWNER): the amount and the user check, as strings', async () => {
    const url = `${A}/payments/reviews/${w.reviewId}/credit-preview?userId=${w.user.id}`;
    const res = await get(url, owner);
    expect(res.status).toBe(200);
    expect(one(res.body)).toMatchObject({
      amountTiyin: '3000000',
      userId: w.user.id,
      blocked: false,
      purchaseFrozen: false,
    });
    expect(
      typeof (one(res.body)['manualCreditsSinceRequest'] as { adjust: Row }).adjust['sumTiyin'],
    ).toBe('string');
    // Both targets, or neither, is a shape error.
    expect((await get(`${A}/payments/reviews/${w.reviewId}/credit-preview`)).status).toBe(400);
    const both = `${url}&intentId=${w.intentId}`;
    expect((await get(both)).status).toBe(400);
    expect((await get(url, operator)).status).toBe(404);
  });
});
