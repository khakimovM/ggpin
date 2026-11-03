import { sessionItemSchema, sessionsResponseSchema } from '@repo/shared';
import { useAuthE2e } from './auth-e2e.helpers';
import {
  bodyOf,
  cookieValue,
  loginAs,
  makeUser,
  ME,
  REFRESH,
  SESSIONS,
  setCookies,
  type Res,
} from './auth-otp.helpers';

describe('web sessions list and revoke (real Postgres)', () => {
  const t = useAuthE2e();
  beforeEach(() => t.clock.set(new Date()));

  const list = (cookie: string): Promise<Res> => t.get(SESSIONS, { cookie });
  const parsed = (res: Res) => {
    const data = bodyOf(res).data as unknown;
    return sessionsResponseSchema.parse(data);
  };
  const revoke = (id: string, cookie: string, headers = t.csrfHeaders): Promise<Res> =>
    t.del(`${SESSIONS}/${id}`, { cookie, ...headers }, t.nextIp());

  it('lists active families with the exact shape; current is true only for this one', async () => {
    const user = await makeUser(t);
    const laptop = await loginAs(t, user, { 'user-agent': 'Laptop/1.0' });
    t.clock.advanceSec(120);
    const phone = await loginAs(t, user, { 'user-agent': 'Phone/2.0' });

    const res = await list(laptop.accessCookie);
    expect(res.statusCode).toBe(200);
    const items = parsed(res);
    for (const item of bodyOf(res).data as unknown as unknown[]) {
      expect(() => sessionItemSchema.strict().parse(item)).not.toThrow();
    }
    expect(items.map((i) => i.id)).toEqual([phone.familyId, laptop.familyId]); // newest first
    expect(items.map((i) => i.current)).toEqual([false, true]);
    expect(items.map((i) => i.userAgent)).toEqual(['Phone/2.0', 'Laptop/1.0']);
    expect(items[0]?.ipMasked).toMatch(/^10\.\d+\.\d+\.x$/); // masked, never the full address

    const fromPhone = parsed(await list(phone.accessCookie));
    expect(fromPhone.map((i) => i.current)).toEqual([true, false]);
  });

  it('lastUsedAt follows rotation while createdAt stays the login time', async () => {
    const login = await loginAs(t, await makeUser(t));
    const startedAt = t.clock.now().toISOString();
    t.clock.advanceSec(300);
    const rotated = await t.post(
      REFRESH,
      {},
      { cookie: login.cookie, ...t.csrfHeaders },
      t.nextIp(),
    );
    expect(rotated.statusCode).toBe(200);
    const access = `access_token=${cookieValue(rotated, 'access_token')}`;
    const [item, ...rest] = parsed(await list(access));
    expect(rest).toHaveLength(0);
    expect(item?.createdAt).toBe(startedAt);
    expect(item?.lastUsedAt).toBe(t.clock.now().toISOString());
  });

  it('does not list revoked or expired sessions, and never exposes hashes or raw IPs', async () => {
    const user = await makeUser(t);
    const keep = await loginAs(t, user);
    const gone = await loginAs(t, user);
    await t.db.webSession.updateMany({
      where: { familyId: gone.familyId },
      data: { revokedAt: t.clock.now() },
    });
    const res = await list(keep.accessCookie);
    expect(parsed(res).map((i) => i.id)).toEqual([keep.familyId]);
    expect(res.body).not.toMatch(/refreshHash|"ip"|\d+\.\d+\.\d+\.\d+/);
  });

  it('requires a session: no cookie -> 401', async () => {
    expect((await t.get(SESSIONS)).statusCode).toBe(401);
    expect((await t.del(`${SESSIONS}/whatever`, t.csrfHeaders, t.nextIp())).statusCode).toBe(401);
  });

  it("DELETE another user's family -> 404, and that session keeps working", async () => {
    const alice = await loginAs(t, await makeUser(t));
    const bob = await loginAs(t, await makeUser(t));
    const res = await revoke(alice.familyId, bob.accessCookie);
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).error?.code).toBe('NOT_FOUND');
    expect((await t.get(ME, { cookie: alice.accessCookie })).statusCode).toBe(200);
    expect(parsed(await list(alice.accessCookie))).toHaveLength(1);
    // An id that does not exist, or is not even plausible, looks exactly the same.
    expect((await revoke('does-not-exist', bob.accessCookie)).statusCode).toBe(404);
    expect((await revoke('x'.repeat(65), bob.accessCookie)).statusCode).toBe(404);
  });

  it("DELETE own other family -> {} and that session's /me and refresh stop working", async () => {
    const user = await makeUser(t);
    const here = await loginAs(t, user);
    const other = await loginAs(t, user);
    expect((await t.get(ME, { cookie: other.accessCookie })).statusCode).toBe(200);

    const res = await revoke(other.familyId, here.accessCookie);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ success: true, data: {} });
    expect(setCookies(res)).toHaveLength(0); // not the caller's own session: cookies untouched
    expect((await t.get(ME, { cookie: other.accessCookie })).statusCode).toBe(401);
    const refresh = await t.post(
      REFRESH,
      {},
      { cookie: other.cookie, ...t.csrfHeaders },
      t.nextIp(),
    );
    expect(refresh.statusCode).toBe(401);
    expect((await t.get(ME, { cookie: here.accessCookie })).statusCode).toBe(200);
    expect(parsed(await list(here.accessCookie)).map((i) => i.id)).toEqual([here.familyId]);
    expect((await revoke(other.familyId, here.accessCookie)).statusCode).toBe(404); // already gone
  });

  it('DELETE the current family ends this session and clears its cookies', async () => {
    const login = await loginAs(t, await makeUser(t));
    const res = await revoke(login.familyId, login.accessCookie);
    expect(res.statusCode).toBe(200);
    expect(setCookies(res).filter((c) => c.includes('Max-Age=0'))).toHaveLength(2);
    expect((await t.get(ME, { cookie: login.accessCookie })).statusCode).toBe(401);
  });

  it('DELETE without X-CSRF-Token or with a foreign Origin -> 404 and the session survives', async () => {
    const user = await makeUser(t);
    const here = await loginAs(t, user);
    const other = await loginAs(t, user);
    expect(
      (await revoke(other.familyId, here.accessCookie, { origin: t.env.WEB_URL })).statusCode,
    ).toBe(404);
    const foreign = await revoke(other.familyId, here.accessCookie, {
      'x-csrf-token': '1',
      origin: 'https://evil.example',
    });
    expect(foreign.statusCode).toBe(404);
    expect((await t.get(ME, { cookie: other.accessCookie })).statusCode).toBe(200);
  });
});
