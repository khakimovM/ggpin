import { BOT_CODE_ISSUE_LIMIT, OTP_CODE_TTL_SEC } from '@repo/shared';
import { OtpLoginService, type IssueCodeResult } from '../otp-login.service';
import { useAuthE2e } from './auth-e2e.helpers';
import { bodyOf, botIssue, makeUser, startNonce, statusUrl, verify } from './auth-otp.helpers';

// The bot (slice S7b) talks to OtpLoginService directly; these tests drive it the same way.
describe('OtpLoginService.issueCode / deny, as the bot uses them (real Postgres)', () => {
  const t = useAuthE2e();
  beforeEach(() => t.clock.set(new Date()));

  const otp = (): OtpLoginService => t.app().get(OtpLoginService);
  const issue = (nonce: string, telegramId: number): Promise<IssueCodeResult> =>
    otp().issueCode({ nonce, telegramId: BigInt(telegramId), now: t.clock.now() });
  const deny = (nonce: string, telegramId: number): Promise<boolean> =>
    otp().deny({ nonce, telegramId: BigInt(telegramId), now: t.clock.now() });
  const statusOf = async (nonce: string): Promise<unknown> =>
    bodyOf(await t.get(statusUrl(nonce), {}, t.nextIp())).data?.['status'];

  it('hands out a 6-digit code once; the same account asking again gets alreadySent, no new code', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    const first = await issue(nonce, user.telegramId);
    expect(first.ok && /^\d{6}$/.test(first.code)).toBe(true);
    const hashBefore = (await t.db.loginRequest.findUniqueOrThrow({ where: { nonce } })).codeHash;

    expect(await issue(nonce, user.telegramId)).toEqual({ ok: false, reason: 'alreadySent' });
    const after = await t.db.loginRequest.findUniqueOrThrow({ where: { nonce } });
    expect(after.codeHash).toBe(hashBefore); // the duplicate delivery changed nothing
    expect(after.telegramId).toBe(BigInt(user.telegramId));
  });

  it('another account on a claimed request gets usedByOther and cannot touch it', async () => {
    const owner = await makeUser(t);
    const intruder = await makeUser(t);
    const nonce = await startNonce(t);
    const issued = await issue(nonce, owner.telegramId);
    expect(await issue(nonce, intruder.telegramId)).toEqual({ ok: false, reason: 'usedByOther' });
    expect(await deny(nonce, intruder.telegramId)).toBe(false);
    expect(await statusOf(nonce)).toBe('CODE_SENT');
    // The owner's code still works.
    const code = issued.ok ? issued.code : '';
    expect((await verify(t, nonce, code)).statusCode).toBe(200);
  });

  it('parallel claims by two accounts: exactly one gets the code', async () => {
    const a = await makeUser(t);
    const b = await makeUser(t);
    const nonce = await startNonce(t);
    const results = await Promise.all([issue(nonce, a.telegramId), issue(nonce, b.telegramId)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: 'usedByOther' });
  });

  it('unknown, malformed, used and expired requests -> expired', async () => {
    const user = await makeUser(t);
    expect(await issue('A'.repeat(43), user.telegramId)).toEqual({ ok: false, reason: 'expired' });
    expect(await issue('nope', user.telegramId)).toEqual({ ok: false, reason: 'expired' });

    const used = await startNonce(t);
    const code = await botIssue(t, used, user.telegramId);
    expect((await verify(t, used, code)).statusCode).toBe(200);
    expect(await issue(used, user.telegramId)).toEqual({ ok: false, reason: 'expired' });

    const stale = await startNonce(t);
    t.clock.advanceSec(601);
    expect(await issue(stale, user.telegramId)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rate limit: the 6th code to one account inside the window is rateLimited; it frees up later', async () => {
    const user = await makeUser(t);
    const other = await makeUser(t);
    for (let i = 0; i < BOT_CODE_ISSUE_LIMIT.max; i += 1) {
      expect((await issue(await startNonce(t), user.telegramId)).ok).toBe(true);
    }
    const sixth = await startNonce(t);
    expect(await issue(sixth, user.telegramId)).toEqual({ ok: false, reason: 'rateLimited' });
    // The refused request stays claimable and other accounts are unaffected.
    expect(await statusOf(sixth)).toBe('PENDING');
    expect((await issue(sixth, other.telegramId)).ok).toBe(true);

    t.clock.advanceSec(BOT_CODE_ISSUE_LIMIT.windowSec + 1);
    expect((await issue(await startNonce(t), user.telegramId)).ok).toBe(true);
  });

  it('rate limit holds under parallel issuing for one account', async () => {
    const user = await makeUser(t);
    const nonces = await Promise.all(Array.from({ length: 8 }, () => startNonce(t)));
    const results = await Promise.all(nonces.map((n) => issue(n, user.telegramId)));
    expect(results.filter((r) => r.ok)).toHaveLength(BOT_CODE_ISSUE_LIMIT.max);
    expect(results.filter((r) => !r.ok && r.reason === 'rateLimited')).toHaveLength(
      8 - BOT_CODE_ISSUE_LIMIT.max,
    );
  });

  it('deny: status DENIED, verify -> CODE_EXPIRED, idempotent, and issueCode afterwards -> expired', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    const code = await botIssue(t, nonce, user.telegramId);

    expect(await deny(nonce, user.telegramId)).toBe(true);
    expect(await deny(nonce, user.telegramId)).toBe(true); // replayed callback
    expect(await statusOf(nonce)).toBe('DENIED');

    const res = await verify(t, nonce, code);
    expect(res.statusCode).toBe(422);
    expect(bodyOf(res).error?.code).toBe('CODE_EXPIRED');
    expect(await t.db.webSession.count({ where: { userId: user.userId } })).toBe(0);
    expect(await issue(nonce, user.telegramId)).toEqual({ ok: false, reason: 'expired' });
  });

  it('deny does nothing for a PENDING request, an unknown nonce or an expired code', async () => {
    const user = await makeUser(t);
    const pending = await startNonce(t);
    expect(await deny(pending, user.telegramId)).toBe(false);
    expect(await statusOf(pending)).toBe('PENDING');
    expect(await deny('A'.repeat(43), user.telegramId)).toBe(false);

    await botIssue(t, pending, user.telegramId);
    t.clock.advanceSec(OTP_CODE_TTL_SEC + 1);
    expect(await deny(pending, user.telegramId)).toBe(false);
  });

  it('an exhausted code is reported expired to the bot too, not alreadySent', async () => {
    const user = await makeUser(t);
    const nonce = await startNonce(t);
    await botIssue(t, nonce, user.telegramId);
    await t.db.loginRequest.update({ where: { nonce }, data: { attempts: 5 } });
    expect(await issue(nonce, user.telegramId)).toEqual({ ok: false, reason: 'expired' });
    expect(await statusOf(nonce)).toBe('EXPIRED');
  });
});
