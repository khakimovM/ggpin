import { getQueueToken } from '@nestjs/bullmq';
import { QUEUES, sessionEndCallbackData, type TgOutboxJob } from '@repo/shared';
import type { Queue } from 'bullmq';
import { AppError } from '../../../common/exceptions/app-error';
import { newLoginJobId } from '../new-login-notice.service';
import { OtpLoginService } from '../otp-login.service';
import { TgOutboxEnqueuer } from '../../notifications/tg-outbox.enqueuer';
import { WebSessionService } from '../web-session.service';
import { useAuthE2e } from './auth-e2e.helpers';
import {
  ME,
  REFRESH,
  botIssue,
  bodyOf,
  loginAs,
  makeUser,
  startNonce,
  statusUrl,
  verify,
} from './auth-otp.helpers';

// D-B: the LoginRequest remembers the session its code opened, so "this was not me" still
// works after the code was used, and the account is told about every new sign-in.
describe('login -> session link, deny after use, new-login notice (real Postgres and Redis)', () => {
  const t = useAuthE2e();
  const otp = (): OtpLoginService => t.app().get(OtpLoginService);
  const queue = (): Queue => t.app().get<Queue>(getQueueToken(QUEUES.TG_OUTBOX));
  const deny = (nonce: string, telegramId: number) =>
    otp().deny({ nonce, telegramId: BigInt(telegramId), now: t.clock.now() });
  const meStatus = async (cookie: string): Promise<number> =>
    (await t.get(ME, { cookie })).statusCode;
  beforeEach(() => t.clock.set(new Date()));

  it('verify stores the new session family on the request, in the same step as USED', async () => {
    const user = await makeUser(t);
    const login = await loginAs(t, user);
    const row = await t.db.loginRequest.findUniqueOrThrow({ where: { nonce: login.nonce } });
    expect(row.status).toBe('USED');
    expect(row.sessionFamilyId).toBe(login.familyId);
    expect(row.telegramId).toBe(BigInt(user.telegramId));
  });

  it('deny after use ends that session at once: /me -> 401, refresh -> 401, row DENIED with its family', async () => {
    const user = await makeUser(t);
    const login = await loginAs(t, user);
    expect(await meStatus(login.accessCookie)).toBe(200);

    expect(await deny(login.nonce, user.telegramId)).toBe('sessionEnded');

    expect(await meStatus(login.accessCookie)).toBe(401);
    const refreshed = await t.post(REFRESH, {}, { cookie: login.cookie, ...t.csrfHeaders });
    expect(refreshed.statusCode).toBe(401);
    const row = await t.db.loginRequest.findUniqueOrThrow({ where: { nonce: login.nonce } });
    expect(row.status).toBe('DENIED');
    expect(row.sessionFamilyId).toBe(login.familyId);
    const live = await t.db.webSession.count({
      where: { familyId: login.familyId, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('is idempotent: a replayed deny after use is still sessionEnded, no time limit', async () => {
    const user = await makeUser(t);
    const login = await loginAs(t, user);
    expect(await deny(login.nonce, user.telegramId)).toBe('sessionEnded');
    t.clock.advanceSec(30 * 24 * 3600); // a month later
    expect(await deny(login.nonce, user.telegramId)).toBe('sessionEnded');
  });

  it("another account cannot end someone's session through the nonce", async () => {
    const owner = await makeUser(t);
    const intruder = await makeUser(t);
    const login = await loginAs(t, owner);
    expect(await deny(login.nonce, intruder.telegramId)).toBe('expired');
    expect(await meStatus(login.accessCookie)).toBe(200);
    const row = await t.db.loginRequest.findUniqueOrThrow({ where: { nonce: login.nonce } });
    expect(row.status).toBe('USED');
  });

  it('deny before use is still "denied", leaves no session family, and a replay says the same', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);
    expect(await deny(nonce, user.telegramId)).toBe('denied');
    expect(await deny(nonce, user.telegramId)).toBe('denied');
    expect((await verify(t, nonce, code)).statusCode).toBe(422);
    const row = await t.db.loginRequest.findUniqueOrThrow({ where: { nonce } });
    expect(row.sessionFamilyId).toBeNull();
    expect(bodyOf(await t.get(statusUrl(nonce), {}, t.nextIp())).data?.['status']).toBe('DENIED');
  });

  it('nonce of a PENDING or unknown request -> expired', async () => {
    const user = await makeUser(t);
    expect(await deny(await startNonce(t), user.telegramId)).toBe('expired');
    expect(await deny('A'.repeat(43), user.telegramId)).toBe('expired');
  });

  it('deny racing verify ends consistently (30 rounds with staggered start, real Postgres)', async () => {
    const outcomes = { loggedInThenEnded: 0, deniedFirst: 0 };
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    for (let round = 0; round < 30; round += 1) {
      const user = await makeUser(t);
      const nonce = await startNonce(t);
      const code = await botIssue(t, nonce, user.telegramId);
      // The service is called directly (no HTTP latency) and the deny is delayed by 0-14 ms,
      // so the deny lands before, inside and after the verify transaction across the rounds.
      const verifying = otp()
        .verify({ nonce, code, now: t.clock.now(), userAgent: 'race', ip: '203.0.113.9' })
        .then(
          () => 'logged-in' as const,
          (error: unknown) => (error instanceof AppError ? error.code : 'unexpected'),
        );
      const denying = sleep(round % 15).then(() => deny(nonce, user.telegramId));
      const [verified, denied] = await Promise.all([verifying, denying]);

      const row = await t.db.loginRequest.findUniqueOrThrow({ where: { nonce } });
      expect(row.status).toBe('DENIED');
      const live = await t.db.webSession.count({ where: { userId: user.userId, revokedAt: null } });
      expect(live).toBe(0); // never a usable session left behind

      if (verified === 'logged-in') {
        // The code got through: the deny must have ended exactly that session.
        expect(denied).toBe('sessionEnded');
        expect(row.sessionFamilyId).not.toBeNull();
        expect(await t.db.webSession.count({ where: { userId: user.userId } })).toBeGreaterThan(0);
        outcomes.loggedInThenEnded += 1;
      } else {
        // The deny won: the code never opened a session.
        expect(verified).toBe('CODE_EXPIRED');
        expect(denied).toBe('denied');
        expect(row.sessionFamilyId).toBeNull();
        expect(await t.db.webSession.count({ where: { userId: user.userId } })).toBe(0);
        outcomes.deniedFirst += 1;
      }
    }
    expect(outcomes.loggedInThenEnded + outcomes.deniedFirst).toBe(30);
  });

  describe('the new-login notice', () => {
    it('is queued after verify: right chat, text and button, and neither code nor nonce in it', async () => {
      const user = await makeUser(t);
      const nonce = await startNonce(t);
      const code = await botIssue(t, nonce, user.telegramId);
      const res = await verify(t, nonce, code, {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 NoticeTest/1.0 https://evil.example',
      });
      expect(res.statusCode).toBe(200);
      const family = (await t.db.loginRequest.findUniqueOrThrow({ where: { nonce } }))
        .sessionFamilyId;
      expect(family).not.toBeNull();
      const familyId = family ?? '';

      const job = await queue().getJob(newLoginJobId(familyId));
      expect(job).toBeDefined();
      const data = job?.data as TgOutboxJob;
      expect(data.chatId).toBe(String(user.telegramId));
      expect(data.text).toContain('ggpin');
      expect(data.text).toContain('Chrome, Windows'); // a fixed label, never the raw header
      expect(data.text).not.toContain('NoticeTest');
      expect(data.text).not.toContain('evil.example');
      expect(data.text).toMatch(/10\.\d+\.\d+\.x/); // masked address, never the raw one
      const keyboard = data.replyMarkup?.inline_keyboard ?? [];
      expect(keyboard).toHaveLength(1);
      expect(keyboard[0]).toHaveLength(1);
      expect(keyboard[0]?.[0]).toMatchObject({ callback_data: sessionEndCallbackData(familyId) });
      const serialised = JSON.stringify(job?.data);
      expect(serialised).not.toContain(code);
      expect(serialised).not.toContain(nonce);
    });

    it('is not queued for a user who blocked the bot, and the login still works', async () => {
      const user = await makeUser(t);
      await t.db.user.update({ where: { id: user.userId }, data: { botBlockedAt: new Date() } });
      const login = await loginAs(t, user);
      expect(await queue().getJob(newLoginJobId(login.familyId))).toBeUndefined();
      expect(await meStatus(login.accessCookie)).toBe(200);
    });

    it('a queue failure never fails the login', async () => {
      const user = await makeUser(t);
      const spy = jest
        .spyOn(t.app().get(TgOutboxEnqueuer), 'enqueue')
        .mockRejectedValueOnce(new Error('redis down'));
      try {
        const login = await loginAs(t, user);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await meStatus(login.accessCookie)).toBe(200);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('WebSessionService.endSessionFromBot', () => {
    const sessions = (): WebSessionService => t.app().get(WebSessionService);

    it('ends the session of the account that presses the button, once', async () => {
      const user = await makeUser(t);
      const login = await loginAs(t, user);
      const input = { telegramId: BigInt(user.telegramId), familyId: login.familyId };
      expect(await sessions().endSessionFromBot({ ...input, now: t.clock.now() })).toBe(true);
      expect(await meStatus(login.accessCookie)).toBe(401);
      expect(await sessions().endSessionFromBot({ ...input, now: t.clock.now() })).toBe(false);
    });

    it("is false, and harmless, for another account's family, an unknown family and an unknown account", async () => {
      const owner = await makeUser(t);
      const other = await makeUser(t);
      const login = await loginAs(t, owner);
      const now = t.clock.now();
      const otherId = BigInt(other.telegramId);
      expect(
        await sessions().endSessionFromBot({
          telegramId: otherId,
          familyId: login.familyId,
          now,
        }),
      ).toBe(false);
      expect(
        await sessions().endSessionFromBot({
          telegramId: otherId,
          familyId: 'no-such-family',
          now,
        }),
      ).toBe(false);
      expect(
        await sessions().endSessionFromBot({
          telegramId: 1n,
          familyId: login.familyId,
          now,
        }),
      ).toBe(false);
      expect(await meStatus(login.accessCookie)).toBe(200);
    });
  });
});
