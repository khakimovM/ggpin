import { randomBytes } from 'node:crypto';
import { PAY_TOKEN_HEADER, TopupIntentCreatedSchema } from '@repo/shared';
import { CaptureStream } from '../../../common/logging/__tests__/capture-stream';
import { hashPayToken } from '../pay-token';
import { TEST_HOLDER } from './payments.fixtures';
import {
  BASE_TIYIN,
  HOUR,
  newKey,
  tokenOf,
  usePaymentsE2e,
  type TestUser,
} from './payments-e2e.helpers';

// One app for the file: nestjs-pino keeps a process-wide root logger, so the capture stream is
// fixed when the app is built. Everything this file does is also checked against the log.
const logs = new CaptureStream();
const e2e = usePaymentsE2e({ env: { LOG_LEVEL: 'info' }, logDestination: logs });
const GRACE_MS = 86_400_000;
const leaks = new Set<string>([TEST_HOLDER, 'TESTOV S.']);

// cuid2 ids start with a random letter, so a fixed `x` prefix would reproduce the real id
// one time in 26; flip the first letter instead.
function otherId(id: string): string {
  return `${id.startsWith('x') ? 'y' : 'x'}${id.slice(1)}`;
}

async function open(user: TestUser) {
  const res = await e2e.create(user);
  expect(res.status).toBe(201);
  const data = TopupIntentCreatedSchema.parse(res.body.data);
  const token = tokenOf(data.redirectUrl);
  leaks.add(token);
  if (data.card !== null) leaks.add(data.card.number);
  return { ...data, token };
}

describe('GET /payments/pay/:intentId (D-39)', () => {
  it('§2.8 200: exactly the allowed keys, card and masked owner, no-store and no-referrer', async () => {
    const card = await e2e.card();
    const intent = await open(await e2e.newUser({ firstName: 'Sardor', username: 'sardor_x' }));
    const res = await e2e.pay(intent.intentId, intent.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      intentId: intent.intentId,
      status: 'PENDING',
      baseAmountTiyin: '2000000',
      payAmountTiyin: intent.payAmountTiyin,
      card: { bank: 'HUMO', number: card.pan, holderName: 'TESTOV S.' },
      expiresAt: intent.expiresAt,
      ownerHint: 'S***r',
      currency: 'UZS',
    });
    expect(String(res.headers['cache-control'])).toContain('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('§2.8 every failure is the same 404 body: missing, malformed, foreign, rotated, cancelled, expired, non-P2P, unknown and over-long ids', async () => {
    await e2e.card();
    const a = await open(await e2e.newUser());
    const b = await open(await e2e.newUser());
    const rotatedUser = await e2e.newUser();
    const rotated = await open(rotatedUser);
    const relinked = await e2e.post(`/payments/intents/${rotated.intentId}/pay-link`, rotatedUser);
    expect(relinked.status).toBe(200);
    const cancelledUser = await e2e.newUser();
    const cancelled = await open(cancelledUser);
    await e2e.post(`/payments/intents/${cancelled.intentId}/cancel`, cancelledUser);

    // An expired intent that still holds a valid token hash (the sweep has not run yet).
    const holder = await e2e.card({ status: 'VERIFYING' });
    const lateUser = await e2e.newUser();
    const createdAt = new Date(Date.now() - 2 * HOUR);
    const expiredId = await e2e.fixtureIntent(lateUser.id, {
      cardId: holder.id,
      baseTiyin: BASE_TIYIN,
      suffixSom: 1,
      status: 'PENDING',
      createdAt,
      reservedUntil: new Date(Date.now() + 20 * HOUR),
    });
    const expiredToken = randomBytes(32).toString('base64url');
    await e2e.db().paymentIntent.update({
      where: { id: expiredId },
      data: { payTokenHash: hashPayToken(e2e.env.PAY_TOKEN_PEPPER, expiredId, expiredToken) },
    });
    // A provider intent (not P2P) with a valid hash: the pay page is for P2P requests only.
    const clickToken = randomBytes(32).toString('base64url');
    const click = await e2e.db().paymentIntent.create({
      data: {
        userId: lateUser.id,
        provider: 'CLICK',
        amountTiyin: BASE_TIYIN,
        status: 'PENDING',
        purpose: 'TOPUP',
        idempotencyKey: newKey(),
        requestHash: 'click-fixture',
        expiresAt: new Date(Date.now() + HOUR),
      },
    });
    await e2e.db().paymentIntent.update({
      where: { id: click.id },
      data: { payTokenHash: hashPayToken(e2e.env.PAY_TOKEN_PEPPER, click.id, clickToken) },
    });

    const cases: [string, string, string | null][] = [
      ['no token', a.intentId, null],
      ['empty token', a.intentId, ''],
      ['short token', a.intentId, a.token.slice(0, 42)],
      ['long token', a.intentId, `${a.token}A`],
      ['wrong token', a.intentId, randomBytes(32).toString('base64url')],
      ['token of another intent', a.intentId, b.token],
      ['rotated (old token)', rotated.intentId, rotated.token],
      ['cancelled', cancelled.intentId, cancelled.token],
      ['non-P2P intent', click.id, clickToken],
      ['expired', expiredId, expiredToken],
      ['unknown id', otherId(a.intentId), a.token],
      ['malformed id', 'not-an-id!', a.token],
      [
        '100-char id (over the 64 of ResourceIdSchema; longer ones: pay-view-urls)',
        'a'.repeat(100),
        a.token,
      ],
    ];
    const bodies = new Set<string>();
    for (const [name, id, token] of cases) {
      const res = await e2e.pay(id, token);
      expect([name, res.status]).toEqual([name, 404]);
      bodies.add(JSON.stringify(res.body));
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies].join(''))).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
    // Sanity: the valid pairs still open.
    expect((await e2e.pay(a.intentId, a.token)).status).toBe(200);
    expect((await e2e.pay(b.intentId, b.token)).status).toBe(200);
  });

  it('a blocked owner: the valid link gets the same 404 (S4-04), unblocked it opens again', async () => {
    await e2e.card();
    const user = await e2e.newUser();
    const intent = await open(user);
    const ordinary = await e2e.pay(otherId(intent.intentId), intent.token);
    await e2e.db().user.update({ where: { id: user.id }, data: { isBlocked: true } });
    const blocked = await e2e.pay(intent.intentId, intent.token);
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual(ordinary.body);
    await e2e.db().user.update({ where: { id: user.id }, data: { isBlocked: false } });
    expect((await e2e.pay(intent.intentId, intent.token)).status).toBe(200);
  });

  it('PAID: still readable until expiresAt, with card null', async () => {
    await e2e.card();
    const intent = await open(await e2e.newUser());
    const row = await e2e.db().paymentIntent.findUniqueOrThrow({ where: { id: intent.intentId } });
    const paidAt = new Date();
    const reservedUntil = new Date(
      Math.max(row.reservedUntil?.getTime() ?? 0, paidAt.getTime() + GRACE_MS),
    );
    await e2e.db().paymentIntent.update({
      where: { id: intent.intentId },
      data: { status: 'PAID', paidAt, reservedUntil },
    });
    const res = await e2e.pay(intent.intentId, intent.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'PAID', card: null });
  });

  it('per intent: 30 reads a minute, the 31st is 429 with Retry-After (from many IPs)', async () => {
    await e2e.card();
    const intent = await open(await e2e.newUser());
    for (let i = 0; i < 30; i += 1) {
      expect((await e2e.pay(intent.intentId, intent.token)).status).toBe(200);
    }
    const over = await e2e.pay(intent.intentId, intent.token);
    expect(over.status).toBe(429);
    expect(over.body.error?.code).toBe('RATE_LIMITED');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('per IP: 300 a minute, also for failures; the 301st is 429', async () => {
    const ip = '198.51.100.77';
    for (let i = 0; i < 300; i += 1) {
      expect((await e2e.pay('no_such_intent', 'A'.repeat(43), ip)).status).toBe(404);
    }
    const over = await e2e.pay('no_such_intent', 'A'.repeat(43), ip);
    expect(over.status).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
  }, 60_000);

  it('CORS: WEB_URL may send X-Pay-Token without credentials; the admin origin may not', async () => {
    const preflight = (origin: string) =>
      e2e.send('OPTIONS', '/payments/pay/some_intent', {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': PAY_TOKEN_HEADER,
      });
    const web = await preflight(e2e.env.WEB_URL);
    expect(web.headers['access-control-allow-origin']).toBe(e2e.env.WEB_URL);
    expect(String(web.headers['access-control-allow-headers'])).toContain(PAY_TOKEN_HEADER);
    expect(web.headers['access-control-allow-credentials']).toBeUndefined();
    const admin = await preflight(e2e.env.ADMIN_URL);
    expect(admin.headers['access-control-allow-origin']).toBeUndefined();
    // Elsewhere the token header is not allowed at all.
    const other = await e2e.send('OPTIONS', '/payments/intents', {
      origin: e2e.env.WEB_URL,
      'access-control-request-method': 'POST',
      'access-control-request-headers': PAY_TOKEN_HEADER,
    });
    expect(String(other.headers['access-control-allow-headers'])).not.toContain(PAY_TOKEN_HEADER);
  });
});

describe('logs (D-39: token, card number and holder name never logged)', () => {
  it('after every request of this file, no token, PAN or holder name appears in the log output', async () => {
    // One more request with every sensitive value in a header and the idempotency key.
    await e2e.card();
    const user = await e2e.newUser();
    const intent = await open(user);
    await e2e.send('GET', `/payments/pay/${intent.intentId}`, {
      [PAY_TOKEN_HEADER]: intent.token,
      'idempotency-key': newKey(),
    });
    const text = logs.text();
    expect(text).toContain('request completed');
    for (const secret of leaks) expect(text).not.toContain(secret);
  });
});
