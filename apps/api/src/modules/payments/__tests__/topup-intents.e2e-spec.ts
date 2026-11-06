import { ACCESS_COOKIE_NAME, CSRF_HEADER, TopupIntentCreatedSchema } from '@repo/shared';
import { WebSessionService } from '../../auth/web-session.service';
import {
  BASE_TIYIN,
  HOUR,
  createBody,
  newKey,
  tokenOf,
  usePaymentsE2e,
  type TestUser,
} from './payments-e2e.helpers';

const e2e = usePaymentsE2e();

async function open(user: TestUser) {
  const res = await e2e.create(user);
  expect(res.status).toBe(201);
  return TopupIntentCreatedSchema.parse(res.body.data);
}

/** A web cookie session for the user (a live session family + its access token). */
async function cookieOf(userId: string): Promise<string> {
  const sessions = e2e.app().get(WebSessionService);
  const now = new Date();
  const { familyId } = await sessions.createSession(userId, { ip: '203.0.113.9' }, now);
  return `${ACCESS_COOKIE_NAME}=${sessions.issueAccessToken(userId, familyId, now)}`;
}

describe('GET /payments/intents[/:id]', () => {
  it('own intent: the card while PENDING; the list is newest first and filters by status', async () => {
    const card = await e2e.card();
    const user = await e2e.newUser();
    const first = await open(user);
    const one = await e2e.get(`/payments/intents/${first.intentId}`, user);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({
      intentId: first.intentId,
      status: 'PENDING',
      card: { number: card.pan },
      paidAt: null,
      creditedTiyin: null,
    });
    await e2e.post(`/payments/intents/${first.intentId}/cancel`, user);
    const second = await open(user);

    const list = await e2e.get('/payments/intents', user);
    expect((list.body.data as { intentId: string }[]).map((i) => i.intentId)).toEqual([
      second.intentId,
      first.intentId,
    ]);
    const cancelled = await e2e.get('/payments/intents?status=CANCELLED', user);
    expect(cancelled.body.data).toEqual([
      expect.objectContaining({ intentId: first.intentId, card: null }),
    ]);
    expect((await e2e.get('/payments/intents?limit=101', user)).status).toBe(400);
  });

  it('another user’s intent is 404 for GET, cancel and pay-link, and nothing changes', async () => {
    await e2e.card();
    const owner = await e2e.newUser();
    const intruder = await e2e.newUser();
    const intent = await open(owner);
    const path = `/payments/intents/${intent.intentId}`;
    for (const res of [
      await e2e.get(path, intruder),
      await e2e.post(`${path}/cancel`, intruder),
      await e2e.post(`${path}/pay-link`, intruder),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    }
    expect((await e2e.get('/payments/intents', intruder)).body.data).toEqual([]);
    expect((await e2e.pay(intent.intentId, tokenOf(intent.redirectUrl))).status).toBe(200);
  });
});

describe('overdue PENDING requests are expired by every session route (M1)', () => {
  /** A PENDING request whose deadline passed an hour and a half ago (the sweep has not run). */
  async function overdue(user: TestUser): Promise<string> {
    const card = await e2e.card();
    return e2e.fixtureIntent(user.id, {
      cardId: card.id,
      baseTiyin: BASE_TIYIN,
      suffixSom: 7,
      status: 'PENDING',
      createdAt: new Date(Date.now() - 2 * HOUR),
      reservedUntil: new Date(Date.now() + 20 * HOUR),
    });
  }
  const statusOf = async (id: string) =>
    (await e2e.db().paymentIntent.findUniqueOrThrow({ where: { id } })).status;

  it('create over an overdue PENDING is 201, not 409; the old one becomes EXPIRED', async () => {
    const user = await e2e.newUser();
    const old = await overdue(user);
    expect((await e2e.create(user)).status).toBe(201);
    expect(await statusOf(old)).toBe('EXPIRED');
  });

  it('cancel of an overdue request is 404 and leaves it EXPIRED (not CANCELLED); GET and the list show EXPIRED, card null', async () => {
    const user = await e2e.newUser();
    const old = await overdue(user);
    const cancel = await e2e.post(`/payments/intents/${old}/cancel`, user);
    expect(cancel.status).toBe(404);
    expect(cancel.body.error?.code).toBe('NOT_FOUND');
    expect(await statusOf(old)).toBe('EXPIRED');
    const one = await e2e.get(`/payments/intents/${old}`, user);
    expect(one.body.data).toMatchObject({ intentId: old, status: 'EXPIRED', card: null });
    const list = await e2e.get('/payments/intents', user);
    expect(list.body.data).toEqual([
      expect.objectContaining({ intentId: old, status: 'EXPIRED', card: null }),
    ]);
  });

  it('GET alone expires it too (the list without a cancel first)', async () => {
    const user = await e2e.newUser();
    const old = await overdue(user);
    const list = await e2e.get('/payments/intents?status=PENDING', user);
    expect(list.body.data).toEqual([]);
    expect(await statusOf(old)).toBe('EXPIRED');
  });
});

describe('POST /payments/intents/:id/cancel', () => {
  it('PENDING -> CANCELLED; the pay link dies; the amount stays reserved; a second cancel is 404', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const intent = await open(user);
    const before = await e2e.db().paymentIntent.findUniqueOrThrow({
      where: { id: intent.intentId },
    });
    const res = await e2e.post(`/payments/intents/${intent.intentId}/cancel`, user);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ intentId: intent.intentId, status: 'CANCELLED' });

    const after = await e2e.db().paymentIntent.findUniqueOrThrow({
      where: { id: intent.intentId },
    });
    expect(after.payTokenHash).toBeNull();
    expect(after.reservedUntil).toEqual(before.reservedUntil);
    expect((await e2e.pay(intent.intentId, tokenOf(intent.redirectUrl))).status).toBe(404);
    expect((await e2e.post(`/payments/intents/${intent.intentId}/cancel`, user)).status).toBe(404);
    expect((await e2e.post(`/payments/intents/${intent.intentId}/pay-link`, user)).status).toBe(
      404,
    );
  });

  it('the body is strict', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const intent = await open(user);
    const res = await e2e.post(`/payments/intents/${intent.intentId}/cancel`, user, { x: 1 });
    expect(res.status).toBe(400);
  });
});

describe('POST /payments/intents/:id/pay-link', () => {
  it('a new link for the same intent; the old token dies at once', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const intent = await open(user);
    const res = await e2e.post(`/payments/intents/${intent.intentId}/pay-link`, user);
    expect(res.status).toBe(200);
    const data = res.body.data as { redirectUrl: string; expiresAt: string };
    expect(data.expiresAt).toBe(intent.expiresAt);
    expect(tokenOf(data.redirectUrl)).not.toBe(tokenOf(intent.redirectUrl));
    expect((await e2e.pay(intent.intentId, tokenOf(intent.redirectUrl))).status).toBe(404);
    expect((await e2e.pay(intent.intentId, tokenOf(data.redirectUrl))).status).toBe(200);
  });
});

describe('cookie sessions (web): CSRF on every POST, Bearer exempt', () => {
  it('without X-CSRF-Token or with a foreign Origin the POSTs are 404 and write nothing; with both they pass', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const cookie = await cookieOf(user.id);
    const create = (headers: Record<string, string>) =>
      e2e.send(
        'POST',
        '/payments/intents',
        { cookie, 'idempotency-key': newKey(), ...headers },
        createBody(),
      );
    expect((await create({})).status).toBe(404);
    expect((await create({ [CSRF_HEADER]: '1', origin: 'https://evil.example' })).status).toBe(404);
    expect(await e2e.db().paymentIntent.count({ where: { userId: user.id } })).toBe(0);

    const ok = await create({ [CSRF_HEADER]: '1', origin: e2e.env.WEB_URL });
    expect(ok.status).toBe(201);
    const id = TopupIntentCreatedSchema.parse(ok.body.data).intentId;
    const cancel = await e2e.send('POST', `/payments/intents/${id}/cancel`, { cookie }, {});
    expect(cancel.status).toBe(404);
    // GET is a safe method: no CSRF header needed.
    expect((await e2e.send('GET', `/payments/intents/${id}`, { cookie })).status).toBe(200);
  });

  it('a blocked user gets 403 USER_BLOCKED', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    await e2e.db().user.update({ where: { id: user.id }, data: { isBlocked: true } });
    const res = await e2e.create(user);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('USER_BLOCKED');
  });
});
