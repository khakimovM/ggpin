import { parseStartPayload } from '@repo/shared';
import * as referralCode from '../referral-code';
import { useUsersE2e } from './users-e2e.helpers';

describe('UsersService.ensureTelegramUser (real Postgres)', () => {
  const ctx = useUsersE2e();
  const { now, newId, counts } = ctx;

  describe('creation', () => {
    it('creates 1 User + 1 Wallet; locale from language_code (ru-RU -> ru)', async () => {
      const telegramId = newId();
      const { user, created } = await ctx.users.ensureTelegramUser(
        { telegramId, username: 'nick', firstName: 'Ann', lastName: 'Lee', languageCode: 'ru-RU' },
        { now },
      );
      expect(created).toBe(true);
      expect(user).toMatchObject({
        telegramId,
        username: 'nick',
        firstName: 'Ann',
        lastName: 'Lee',
        locale: 'ru',
        photoUrl: null,
        referredById: null,
        isBlocked: false,
        botBlockedAt: null,
        lastSeenAt: now,
      });
      expect(parseStartPayload(`ref_${user.referralCode}`)).toEqual({
        kind: 'ref',
        code: user.referralCode,
      });
      expect(await counts(telegramId)).toEqual({ users: 1, wallets: 1 });
    });

    it('missing language_code -> uz; unknown language -> uz', async () => {
      const a = await ctx.users.ensureTelegramUser({ telegramId: newId() }, { now });
      const b = await ctx.users.ensureTelegramUser(
        { telegramId: newId(), languageCode: 'en' },
        { now },
      );
      expect(a.user.locale).toBe('uz');
      expect(b.user.locale).toBe('uz');
    });

    it('stores photoUrl only when supplied', async () => {
      const photoUrl = `https://cdn.example.test/${newId()}.jpg`;
      const { user } = await ctx.users.ensureTelegramUser(
        { telegramId: newId(), photoUrl },
        { now },
      );
      expect(user.photoUrl).toBe(photoUrl);
    });
  });

  describe('existing user', () => {
    it('created=false, profile refreshed, locale unchanged, photo kept when not supplied', async () => {
      const telegramId = newId();
      const photoUrl = `https://cdn.example.test/${telegramId}.jpg`;
      const first = await ctx.users.ensureTelegramUser(
        { telegramId, username: 'old', firstName: 'Old', languageCode: 'ru', photoUrl },
        { now },
      );
      // The user explicitly picks uz after sign-up...
      await ctx.users.updateLocale(first.user.id, 'uz');

      const later = new Date(now.getTime() + 60_000);
      const second = await ctx.users.ensureTelegramUser(
        // ...and a later login still says ru: the stored choice must win.
        { telegramId, username: null, firstName: 'New', lastName: 'Name', languageCode: 'ru' },
        { now: later },
      );
      expect(second.created).toBe(false);
      expect(second.user).toMatchObject({
        id: first.user.id,
        username: null,
        firstName: 'New',
        lastName: 'Name',
        locale: 'uz',
        photoUrl,
        referralCode: first.user.referralCode,
        lastSeenAt: later,
      });
      expect(await counts(telegramId)).toEqual({ users: 1, wallets: 1 });
    });

    it('repairs a missing wallet row', async () => {
      const telegramId = newId();
      const { user } = await ctx.users.ensureTelegramUser({ telegramId }, { now });
      await ctx.db.wallet.delete({ where: { userId: user.id } });
      await ctx.users.ensureTelegramUser({ telegramId }, { now });
      expect(await counts(telegramId)).toEqual({ users: 1, wallets: 1 });
    });
  });

  describe('concurrency', () => {
    it('20 parallel calls -> 1 User, 1 Wallet, exactly one created=true', async () => {
      const telegramId = newId();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          ctx.users.ensureTelegramUser({ telegramId, firstName: 'Racer' }, { now }),
        ),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
      expect(await counts(telegramId)).toEqual({ users: 1, wallets: 1 });
    });

    it('20 parallel calls with a referral code bind the inviter exactly once', async () => {
      const inviter = await ctx.users.ensureTelegramUser({ telegramId: newId() }, { now });
      const telegramId = newId();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          ctx.users.ensureTelegramUser({ telegramId }, { now, refCode: inviter.user.referralCode }),
        ),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const row = await ctx.db.user.findUniqueOrThrow({ where: { telegramId } });
      expect(row.referredById).toBe(inviter.user.id);
    });
  });

  describe('referral code collision', () => {
    afterEach(() => jest.restoreAllMocks());

    it('retries with a fresh code when the generated one is taken', async () => {
      const taken = await ctx.users.ensureTelegramUser({ telegramId: newId() }, { now });
      const fresh = 'zz9yy8xx';
      const spy = jest
        .spyOn(referralCode, 'generateReferralCode')
        .mockReturnValueOnce(taken.user.referralCode)
        .mockReturnValueOnce(fresh);
      const { user, created } = await ctx.users.ensureTelegramUser(
        { telegramId: newId() },
        { now },
      );
      expect(created).toBe(true);
      expect(user.referralCode).toBe(fresh);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('fails loudly after 3 collisions and leaves nothing behind', async () => {
      const taken = await ctx.users.ensureTelegramUser({ telegramId: newId() }, { now });
      jest.spyOn(referralCode, 'generateReferralCode').mockReturnValue(taken.user.referralCode);
      const telegramId = newId();
      await expect(ctx.users.ensureTelegramUser({ telegramId }, { now })).rejects.toThrow(
        /referral code/i,
      );
      expect(await counts(telegramId)).toEqual({ users: 0, wallets: 0 });
    });
  });

  describe('bot blocked flag', () => {
    it('mark / clear round trip, both idempotent; the first timestamp is kept', async () => {
      const telegramId = newId();
      await ctx.users.ensureTelegramUser({ telegramId }, { now });
      const read = async () =>
        (await ctx.db.user.findUniqueOrThrow({ where: { telegramId } })).botBlockedAt;

      expect(await read()).toBeNull();
      const t1 = new Date('2026-06-02T00:00:00.000Z');
      await ctx.users.markBotBlocked(telegramId, t1);
      expect(await read()).toEqual(t1);
      await ctx.users.markBotBlocked(telegramId, new Date('2026-06-03T00:00:00.000Z'));
      expect(await read()).toEqual(t1);

      await ctx.users.clearBotBlocked(telegramId);
      expect(await read()).toBeNull();
      await ctx.users.clearBotBlocked(telegramId);
      expect(await read()).toBeNull();
    });

    it('is a silent no-op for an unknown telegramId', async () => {
      await expect(ctx.users.markBotBlocked(newId(), now)).resolves.toBeUndefined();
      await expect(ctx.users.clearBotBlocked(newId())).resolves.toBeUndefined();
    });
  });

  describe('getMe / updateLocale', () => {
    it('returns the /me shape and persists an explicit locale choice', async () => {
      const { user } = await ctx.users.ensureTelegramUser(
        { telegramId: newId(), username: 'me', languageCode: 'ru' },
        { now },
      );
      const me = await ctx.users.getMe(user.id);
      expect(me).toEqual({
        id: user.id,
        telegramId: user.telegramId.toString(),
        username: 'me',
        firstName: null,
        photoUrl: null,
        locale: 'ru',
        referralCode: user.referralCode,
        phoneLinked: false,
      });
      expect((await ctx.users.updateLocale(user.id, 'uz')).locale).toBe('uz');
      expect((await ctx.users.getMe(user.id)).locale).toBe('uz');
    });

    it('unknown user id -> NOT_FOUND', async () => {
      await expect(ctx.users.getMe('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(ctx.users.updateLocale('does-not-exist', 'ru')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
