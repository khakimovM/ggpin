import { CSRF_HEADER, OTP_CODE_TTL_SEC } from '@repo/shared';
import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import { LoginRequestRepository } from '../../auth/login-request.repository';
import { OtpLoginService } from '../../auth/otp-login.service';
import { AdminLoginRequestRepository } from '../auth/admin-login-request.repository';
import { AdminLoginService } from '../auth/admin-login.service';
import { ADMIN_BASE } from './admin-e2e.api';
import { useAdminE2e } from './admin-e2e.harness';

const USER_VERIFY = '/api/v1/auth/telegram/verify';

// The web login and the admin login share one table (LoginRequest, kind USER | ADMIN). A nonce
// of one flow must be dead in the other at every step: claiming a code, checking it, denying it
// and releasing it (S2-M1 / S2-4). Each step is proven in both directions on the real app, and
// the repository's own claim is proven directly, since the service also checks the kind first.
describe('user and admin login requests stay apart (real app)', () => {
  const t = useAdminE2e();
  const otp = () => t.app().get(OtpLoginService);
  const adminLogin = () => t.app().get(AdminLoginService);
  const rowOf = (nonce: string) => t.db().loginRequest.findUniqueOrThrow({ where: { nonce } });
  const snapshot = async (nonce: string) => {
    const r = await rowOf(nonce);
    return { status: r.status, attempts: r.attempts, codeHash: r.codeHash, tg: r.telegramId };
  };

  /** A web-login nonce, with its code issued through the user flow. */
  const userCode = async () => {
    const telegramId = BigInt(nextTestTelegramId());
    const { nonce } = await otp().start(t.clock.now());
    t.trackNonce(nonce);
    const issued = await otp().issueCode({ nonce, telegramId, now: t.clock.now() });
    if (!issued.ok) throw new Error(`user issueCode refused: ${issued.reason}`);
    return { nonce, telegramId, code: issued.code };
  };

  /** An admin-login nonce, with its code issued through the admin flow. */
  const adminCode = async () => {
    const admin = await t.newAdmin('OWNER');
    const nonce = await t.start();
    const issued = await t.issue(nonce, admin.telegramId);
    if (!issued.ok) throw new Error(`admin issueCode refused: ${issued.reason}`);
    return { nonce, telegramId: admin.telegramId, code: issued.code };
  };

  it('(a) the user flow cannot issue a code for an admin nonce, nor the admin flow for a user one', async () => {
    const admin = await t.newAdmin('OWNER');
    const adminNonce = await t.start();
    const asUser = await otp().issueCode({
      nonce: adminNonce,
      telegramId: admin.telegramId,
      now: t.clock.now(),
    });
    expect(asUser).toEqual({ ok: false, reason: 'expired' });
    expect(await snapshot(adminNonce)).toEqual({
      status: 'PENDING',
      attempts: 0,
      codeHash: null,
      tg: null,
    });

    const { nonce: userNonce } = await otp().start(t.clock.now());
    t.trackNonce(userNonce);
    expect(await t.issue(userNonce, admin.telegramId)).toEqual({ ok: false, reason: 'expired' });
    expect((await snapshot(userNonce)).status).toBe('PENDING');
  });

  it('(a) the repository claim itself is kind-scoped (the service check aside)', async () => {
    const userRepo = t.app().get(LoginRequestRepository);
    const adminRepo = t.app().get(AdminLoginRequestRepository);
    const adminNonce = await t.start();
    const { nonce: userNonce } = await otp().start(t.clock.now());
    t.trackNonce(userNonce);
    const now = t.clock.now();
    const claim = (nonce: string) => ({
      nonce,
      telegramId: BigInt(nextTestTelegramId()),
      codeHash: 'a'.repeat(64),
      codeExpiresAt: new Date(now.getTime() + OTP_CODE_TTL_SEC * 1000),
      now,
    });
    expect(await userRepo.transaction((tx) => userRepo.claimForCode(claim(adminNonce), tx))).toBe(
      false,
    );
    expect(await adminRepo.transaction((tx) => adminRepo.claimForCode(claim(userNonce), tx))).toBe(
      false,
    );
    expect((await snapshot(adminNonce)).status).toBe('PENDING');
    expect((await snapshot(userNonce)).status).toBe('PENDING');
  });

  it('(b) the admin verify with a user nonce and its right code: CODE_EXPIRED, no attempt counted', async () => {
    const user = await userCode();
    const before = await snapshot(user.nonce);
    const res = await t.verify(user.nonce, user.code);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CODE_EXPIRED');
    expect(await snapshot(user.nonce)).toEqual(before); // CODE_SENT, attempts 0
    expect(before).toMatchObject({ status: 'CODE_SENT', attempts: 0 });
  });

  it('(c) the user verify with an admin nonce and its right code: CODE_EXPIRED, no attempt counted', async () => {
    const admin = await adminCode();
    const before = await snapshot(admin.nonce);
    const headers = { origin: t.env.WEB_URL, [CSRF_HEADER]: 'e2e' };
    const res = await t.request('POST', USER_VERIFY, headers, undefined, {
      nonce: admin.nonce,
      code: admin.code,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CODE_EXPIRED');
    expect(await snapshot(admin.nonce)).toEqual(before);
    expect(before).toMatchObject({ status: 'CODE_SENT', attempts: 0 });
  });

  it('(c) the user deny and release do not touch an admin row; the admin ones not a user row', async () => {
    const admin = await adminCode();
    const adminBefore = await snapshot(admin.nonce);
    const now = t.clock.now();
    const asAdminRow = { nonce: admin.nonce, telegramId: admin.telegramId, now };
    expect(await otp().deny(asAdminRow)).toBe('expired');
    expect(await otp().releaseCode({ ...asAdminRow, code: admin.code })).toBe(false);
    expect(await snapshot(admin.nonce)).toEqual(adminBefore);

    const user = await userCode();
    const userBefore = await snapshot(user.nonce);
    const asUserRow = { nonce: user.nonce, telegramId: user.telegramId, now };
    expect(await adminLogin().deny(asUserRow)).toBe('expired'); // the bot's ad:<nonce> button
    expect(await adminLogin().releaseCode({ ...asUserRow, code: user.code })).toBe(false);
    expect(await snapshot(user.nonce)).toEqual(userBefore);

    // Both rows still work in their own flow.
    expect((await t.verify(admin.nonce, admin.code)).statusCode).toBe(200);
    const headers = { origin: t.env.WEB_URL, [CSRF_HEADER]: 'e2e' };
    const userVerify = await t.request('POST', USER_VERIFY, headers, undefined, {
      nonce: user.nonce,
      code: user.code,
    });
    // No user account behind this Telegram id: the user flow's own answer, after its own attempt.
    expect(userVerify.json<{ error: { code: string } }>().error.code).toBe('CODE_EXPIRED');
    expect((await snapshot(user.nonce)).attempts).toBe(1);
  });

  it('the status routes do not show the other flow’s request', async () => {
    const user = await userCode();
    const admin = await adminCode();
    expect((await t.request('GET', `${ADMIN_BASE}/status/${user.nonce}`, t.spa())).statusCode).toBe(
      404,
    );
    await expect(otp().status(admin.nonce, t.clock.now())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
