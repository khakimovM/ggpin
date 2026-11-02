import { ACCESS_COOKIE_NAME } from '@repo/shared';
import { CaptureStream } from '../../../common/logging/__tests__/capture-stream';
import { OtpLoginService } from '../otp-login.service';
import { useAuthE2e } from './auth-e2e.helpers';
import {
  botIssue,
  loginAs,
  cookieValue,
  makeUser,
  REFRESH,
  startNonce,
  statusUrl,
  verify,
  LOGOUT,
} from './auth-otp.helpers';

// One app for the file: nestjs-pino keeps a process-wide root logger, so the capture stream is
// fixed when the app is built.
describe('auth secrets never reach the logs (real pipeline, real Postgres)', () => {
  const logs = new CaptureStream();
  const t = useAuthE2e({ logs });

  it('the OTP code, login nonce, refresh token and access token appear nowhere in the log output', async () => {
    logs.clear();
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);

    await t.get(statusUrl(nonce), {}, t.nextIp());
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    await verify(t, nonce, wrong); // a failing request: goes through the error logger
    const ok = await verify(t, nonce, code);
    expect(ok.statusCode).toBe(200);
    const access = cookieValue(ok, ACCESS_COOKIE_NAME);
    const refreshToken = cookieValue(ok, 'refresh_token');

    const cookie = `${ACCESS_COOKIE_NAME}=${access}; refresh_token=${refreshToken}`;
    const rotated = await t.post(REFRESH, {}, { cookie, ...t.csrfHeaders }, t.nextIp());
    expect(rotated.statusCode).toBe(200);
    const replay = await t.post(REFRESH, {}, { cookie, ...t.csrfHeaders }, t.nextIp()); // reuse -> error
    expect(replay.statusCode).toBe(401);
    await t.post(LOGOUT, {}, { cookie, ...t.csrfHeaders }, t.nextIp());

    // The access log line is written after the response; give it a moment.
    for (let i = 0; i < 50 && !logs.text().includes('request completed'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const output = logs.text();
    expect(output).toContain('request completed');
    expect(output).toContain('"status":401'); // the reuse error was logged, and still clean
    for (const secret of [
      code,
      wrong,
      nonce,
      access,
      refreshToken,
      cookieValue(rotated, 'refresh_token'),
      cookieValue(rotated, ACCESS_COOKIE_NAME),
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('security events are logged as warns with ids only: reuse, attempts exhausted, deny', async () => {
    logs.clear();
    const user = await makeUser(t);
    const otp = t.app().get(OtpLoginService);
    const denyFor = (nonce: string) =>
      otp.deny({ nonce, telegramId: BigInt(user.telegramId), now: t.clock.now() });

    // OTP attempts exhausted: five wrong codes on one request.
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i += 1) await verify(t, nonce, wrong);
    const requestId = (await t.db.loginRequest.findUniqueOrThrow({ where: { nonce } })).id;

    // deny before use, and deny after use.
    const early = await startNonce(t);
    await botIssue(t, early, user.telegramId);
    expect(await denyFor(early)).toBe('denied');
    const login = await loginAs(t, user);
    expect(await denyFor(login.nonce)).toBe('sessionEnded');
    expect(await denyFor(login.nonce)).toBe('sessionEnded'); // a replay logs nothing new

    // Token reuse: rotate once, present the old token again.
    const second = await loginAs(t, user);
    const rotated = await t.post(
      REFRESH,
      {},
      { cookie: second.cookie, ...t.csrfHeaders },
      t.nextIp(),
    );
    expect(rotated.statusCode).toBe(200);
    await t.post(REFRESH, {}, { cookie: second.cookie, ...t.csrfHeaders }, t.nextIp());

    const output = logs.text();
    const events = (name: string): number => output.split(`security event=${name}`).length - 1;
    expect(output).toContain(`security event=OTP_ATTEMPTS_EXHAUSTED loginRequestId=${requestId}`);
    expect(events('OTP_ATTEMPTS_EXHAUSTED')).toBe(1);
    expect(events('LOGIN_DENIED')).toBe(1);
    expect(output).toContain(
      `security event=LOGIN_SESSION_ENDED userId=${user.userId} familyId=${login.familyId}`,
    );
    expect(events('LOGIN_SESSION_ENDED')).toBe(1);
    expect(output).toContain(
      `security event=TOKEN_REUSE_DETECTED userId=${user.userId} familyId=${second.familyId}`,
    );
    expect(output).toContain('"level":"warn"');
    for (const secret of [code, wrong, nonce, early, login.nonce, second.refresh, second.access]) {
      expect(output).not.toContain(secret);
    }
  });
});
