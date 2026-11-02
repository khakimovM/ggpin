import { ACCESS_COOKIE_NAME } from '@repo/shared';
import { CaptureStream } from '../../../common/logging/__tests__/capture-stream';
import { useAuthE2e } from './auth-e2e.helpers';
import {
  botIssue,
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
});
