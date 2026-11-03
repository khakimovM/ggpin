import { ME, VERIFY, START, loginAs, makeUser } from './auth-otp.helpers';
import { useAuthE2e } from './auth-e2e.helpers';

describe('Cache-Control: no-store on /auth/* and /me* (real pipeline)', () => {
  const t = useAuthE2e();

  it('is set on successes, validation errors, 401s and 404s under /auth', async () => {
    const start = await t.post(START, {}, t.csrfHeaders, t.nextIp());
    t.trackNonce(String(start.json<{ data: { nonce: string } }>().data.nonce));
    const responses = [
      start, // 200
      await t.post(VERIFY, { nonce: 'B'.repeat(43), code: '123456' }, t.csrfHeaders, t.nextIp()), // 422
      await t.post(VERIFY, { nonce: 'x' }, t.csrfHeaders, t.nextIp()), // 400
      await t.get('/api/v1/auth/sessions', {}, t.nextIp()), // 401
      await t.get('/api/v1/auth/no-such-route', {}, t.nextIp()), // 404
    ];
    expect(responses.map((r) => r.statusCode)).toEqual([200, 422, 400, 401, 404]);
    for (const res of responses) expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is set on /me for an authenticated call and for an anonymous one', async () => {
    const login = await loginAs(t, await makeUser(t));
    const ok = await t.get(ME, { cookie: login.accessCookie });
    const anonymous = await t.get(ME);
    expect(ok.statusCode).toBe(200);
    expect(anonymous.statusCode).toBe(401);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(anonymous.headers['cache-control']).toBe('no-store');
  });

  it.each(['/api/v1/%6De', '/api/v1/%6de', '/api/v1/%61uth/sessions', '/api/v1/auth%2Fsessions'])(
    'a percent-encoded spelling of a protected path (%s) is still no-store',
    async (url) => {
      const res = await t.get(url, {}, t.nextIp());
      expect(res.headers['cache-control']).toBe('no-store');
    },
  );

  it('a request that matches no route at all is no-store', async () => {
    const res = await t.get('/nothing/here', {}, t.nextIp());
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('does not touch unrelated routes', async () => {
    const res = await t.get('/api/v1/health/live');
    expect(res.headers['cache-control']).not.toBe('no-store');
  });
});

describe('rate limits are keyed by client network (real pipeline)', () => {
  const t = useAuthE2e();
  const nonce = 'B'.repeat(43);
  const hit = (ip: string) => t.post(VERIFY, { nonce, code: '123456' }, t.csrfHeaders, ip);

  it('IPv6 clients of one /64 share a bucket; another /64 does not', async () => {
    // 30 calls per minute on verify: spread them over three addresses of 2001:db8:aa:1::/64.
    const same = ['2001:db8:aa:1::1', '2001:db8:aa:1:ffff::2', '2001:db8:aa:1:1234:5678:9abc:def0'];
    for (let i = 0; i < 30; i += 1) {
      const res = await hit(same[i % same.length] ?? '');
      expect(res.statusCode).toBe(422);
    }
    expect((await hit('2001:db8:aa:1::99')).statusCode).toBe(429);
    expect((await hit('2001:db8:aa:2::1')).statusCode).toBe(422); // a different /64
  });

  it('an IPv4-mapped IPv6 address counts as the plain IPv4 address', async () => {
    const v4 = '10.250.3.4';
    for (let i = 0; i < 30; i += 1) {
      const res = await hit(i % 2 === 0 ? v4 : `::ffff:${v4}`);
      expect(res.statusCode).toBe(422);
    }
    expect((await hit(v4)).statusCode).toBe(429);
    expect((await hit(`::ffff:${v4}`)).statusCode).toBe(429);
    expect((await hit('10.250.3.5')).statusCode).toBe(422);
  });

  it('IPv4 addresses are not grouped: neighbours keep separate budgets', async () => {
    for (let i = 0; i < 30; i += 1) await hit('10.251.0.1');
    expect((await hit('10.251.0.1')).statusCode).toBe(429);
    expect((await hit('10.251.0.2')).statusCode).toBe(422);
  });
});
