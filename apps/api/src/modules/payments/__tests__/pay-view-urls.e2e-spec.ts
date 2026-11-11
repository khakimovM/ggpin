import { randomBytes } from 'node:crypto';
import { PAY_TOKEN_HEADER } from '@repo/shared';
import { MAX_PARAM_LENGTH } from '../../../common/http/http-limits';
import { usePaymentsE2e, type Reply } from './payments-e2e.helpers';

// URL shapes that never come from a real pay link (D-42 (2), (3)). An over-long id must look
// exactly like any other failure: the same 404 body AND the same headers (CORS, no-store,
// no-referrer, helmet, X-Request-Id), because it now takes the ordinary route
// (maxParamLength 16 384) and the shape check turns it into the same 404.
const e2e = usePaymentsE2e();
const token = randomBytes(32).toString('base64url');

// Headers whose values must be identical; X-Request-Id differs per request, so only its presence.
const SAME = [
  'access-control-allow-origin',
  'access-control-expose-headers',
  'cache-control',
  'content-security-policy',
  'content-type',
  'referrer-policy',
  'strict-transport-security',
  'vary',
  'x-content-type-options',
  'x-frame-options',
] as const;

function payFrom(id: string): Promise<Reply> {
  return e2e.send('GET', `/payments/pay/${id}`, {
    origin: e2e.env.WEB_URL,
    [PAY_TOKEN_HEADER]: token,
  });
}

const pick = (reply: Reply) => Object.fromEntries(SAME.map((name) => [name, reply.headers[name]]));

describe('over-long pay ids (D-42 (2))', () => {
  it('101 and ~8 000 characters: exactly the ordinary 404, body and headers', async () => {
    const ordinary = await payFrom('unknown_id');
    expect(ordinary.status).toBe(404);
    expect(ordinary.headers['access-control-allow-origin']).toBe(e2e.env.WEB_URL);
    expect(String(ordinary.headers['cache-control'])).toContain('no-store');
    expect(ordinary.headers['referrer-policy']).toBe('no-referrer');
    expect(ordinary.headers['content-security-policy']).toBeDefined();

    for (const length of [101, 8_000]) {
      const long = await payFrom('a'.repeat(length));
      expect([length, long.status]).toEqual([length, 404]);
      expect(long.body).toEqual(ordinary.body);
      expect(pick(long)).toEqual(pick(ordinary));
      expect(long.headers['x-request-id']).toEqual(expect.any(String));
    }
  });

  it('the router limit is far above any real id (a cuid is 25 characters)', () => {
    expect(MAX_PARAM_LENGTH).toBe(16_384);
  });

  it('session routes with an over-long id get the contract answer: 400 VALIDATION_ERROR', async () => {
    const user = await e2e.newUser();
    const id = 'a'.repeat(101);
    for (const reply of [
      await e2e.get(`/payments/intents/${id}`, user),
      await e2e.post(`/payments/intents/${id}/cancel`, user),
      await e2e.post(`/payments/intents/${id}/pay-link`, user),
    ]) {
      expect(reply.status).toBe(400);
      expect(reply.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    }
  });
});

describe('broken percent-encoding (D-42 (3))', () => {
  it('%ZZ is a raw 400 before routing; the body carries no intent or token data', async () => {
    const res = await e2e.app().inject({
      method: 'GET',
      url: '/api/v1/payments/pay/%ZZ',
      headers: { origin: e2e.env.WEB_URL, [PAY_TOKEN_HEADER]: token },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(token);
    expect(res.body.toLowerCase()).not.toContain('intent');
    expect(res.body).not.toContain('"success"');
  });
});
