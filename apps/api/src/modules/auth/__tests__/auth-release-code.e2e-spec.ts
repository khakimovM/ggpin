import { OtpLoginService } from '../otp-login.service';
import { useAuthE2e } from './auth-e2e.helpers';
import { bodyOf, botIssue, makeUser, startNonce, statusUrl, verify } from './auth-otp.helpers';

// D-C: the bot could not deliver the code, so the same link must work again.
describe('OtpLoginService.releaseCode (real Postgres)', () => {
  const t = useAuthE2e();
  const otp = (): OtpLoginService => t.app().get(OtpLoginService);
  const row = (nonce: string) => t.db.loginRequest.findUniqueOrThrow({ where: { nonce } });
  const release = (nonce: string, telegramId: number, code: string) =>
    otp().releaseCode({ nonce, telegramId: BigInt(telegramId), code, now: t.clock.now() });
  beforeEach(() => t.clock.set(new Date('2026-11-02T10:00:00.000Z')));

  it('start() stamps createdAt from the injected clock', async () => {
    const nonce = await startNonce(t);
    const created = await row(nonce);
    expect(created.createdAt.toISOString()).toBe('2026-11-02T10:00:00.000Z');
    expect(created.expiresAt.toISOString()).toBe('2026-11-02T10:10:00.000Z');
  });

  it('puts the request back to PENDING with the nonce own lifetime (createdAt + 10 min)', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    t.clock.advanceSec(100);
    const code = await botIssue(t, nonce, user.telegramId);
    expect((await row(nonce)).status).toBe('CODE_SENT');

    t.clock.advanceSec(20);
    expect(await release(nonce, user.telegramId, code)).toBe(true);
    const released = await row(nonce);
    expect(released.status).toBe('PENDING');
    expect(released.telegramId).toBeNull();
    expect(released.codeHash).toBeNull();
    expect(released.attempts).toBe(0);
    expect(released.expiresAt.toISOString()).toBe('2026-11-02T10:10:00.000Z');
    expect(bodyOf(await t.get(statusUrl(nonce), {}, t.nextIp())).data?.['status']).toBe('PENDING');
    // The undelivered code is dead; a fresh one can be issued, to the same or another account.
    expect((await verify(t, nonce, code)).statusCode).toBe(422);
    const again = await otp().issueCode({
      nonce,
      telegramId: BigInt(user.telegramId),
      now: t.clock.now(),
    });
    expect(again.ok).toBe(true);
  });

  it('refuses: wrong code, another account, a code already tried, a second release', async () => {
    const user = await makeUser(t);
    const other = await makeUser(t);
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);
    const wrong = code === '000000' ? '000001' : '000000';

    expect(await release(nonce, user.telegramId, wrong)).toBe(false);
    expect(await release(nonce, other.telegramId, code)).toBe(false);
    expect((await row(nonce)).status).toBe('CODE_SENT');

    await verify(t, nonce, wrong); // one wrong attempt: somebody is already trying
    expect(await release(nonce, user.telegramId, code)).toBe(false);
    expect((await row(nonce)).status).toBe('CODE_SENT');

    const fresh = await startNonce(t);
    const freshCode = await botIssue(t, fresh, user.telegramId);
    expect(await release(fresh, user.telegramId, freshCode)).toBe(true);
    expect(await release(fresh, user.telegramId, freshCode)).toBe(false);
    expect(await release('not-a-nonce', user.telegramId, freshCode)).toBe(false);
  });

  it('a released code no longer counts toward the 5-per-10-min issue limit', async () => {
    const user = await makeUser(t);
    for (let i = 0; i < 7; i += 1) {
      const nonce = await startNonce(t);
      const code = await botIssue(t, nonce, user.telegramId); // throws when rateLimited
      expect(await release(nonce, user.telegramId, code)).toBe(true);
    }
  });
});
