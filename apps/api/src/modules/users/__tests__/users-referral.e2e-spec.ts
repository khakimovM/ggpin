import { useUsersE2e } from './users-e2e.helpers';

describe('UsersService referral binding (real Postgres)', () => {
  const ctx = useUsersE2e();
  const { now, newId } = ctx;

  describe('referral binding', () => {
    it('new user with a valid code is bound; a later different code does not rebind', async () => {
      const a = await ctx.users.ensureTelegramUser({ telegramId: newId() }, { now });
      const c = await ctx.users.ensureTelegramUser({ telegramId: newId() }, { now });
      const bId = newId();

      const first = await ctx.users.ensureTelegramUser(
        { telegramId: bId },
        { now, refCode: a.user.referralCode },
      );
      expect(first.created).toBe(true);
      expect(first.user.referredById).toBe(a.user.id);

      const again = await ctx.users.ensureTelegramUser(
        { telegramId: bId },
        { now, refCode: c.user.referralCode },
      );
      expect(again.created).toBe(false);
      expect(again.user.referredById).toBe(a.user.id);
      expect(
        (await ctx.db.user.findUniqueOrThrow({ where: { telegramId: bId } })).referredById,
      ).toBe(a.user.id);
    });

    it('an existing user without an inviter is never bound later (Q7)', async () => {
      const a = await ctx.users.ensureTelegramUser({ telegramId: newId() }, { now });
      const telegramId = newId();
      await ctx.users.ensureTelegramUser({ telegramId }, { now });
      const again = await ctx.users.ensureTelegramUser(
        { telegramId },
        { now, refCode: a.user.referralCode },
      );
      expect(again.created).toBe(false);
      expect(again.user.referredById).toBeNull();
      expect(
        (await ctx.db.user.findUniqueOrThrow({ where: { telegramId } })).referredById,
      ).toBeNull();
    });

    it('unknown and malformed codes are ignored without error', async () => {
      for (const refCode of ['nosuchcd', 'x', 'UPPERCAS', 'a b;c--d', '']) {
        const telegramId = newId();
        const { user, created } = await ctx.users.ensureTelegramUser(
          { telegramId },
          { now, refCode },
        );
        expect(created).toBe(true);
        expect(user.referredById).toBeNull();
      }
    });

    it('a blocked inviter does not bind', async () => {
      const a = await ctx.users.ensureTelegramUser({ telegramId: newId() }, { now });
      await ctx.db.user.update({ where: { id: a.user.id }, data: { isBlocked: true } });
      const { user, created } = await ctx.users.ensureTelegramUser(
        { telegramId: newId() },
        { now, refCode: a.user.referralCode },
      );
      expect(created).toBe(true);
      expect(user.referredById).toBeNull();
    });

    it('the DB still rejects a self-referral (CHECK referredById <> id)', async () => {
      const { user } = await ctx.users.ensureTelegramUser({ telegramId: newId() }, { now });
      await expect(
        ctx.db.user.update({ where: { id: user.id }, data: { referredById: user.id } }),
      ).rejects.toThrow();
    });
  });
});
