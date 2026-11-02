import type { User } from '@repo/db';
import { meSchema } from '@repo/shared';
import { toMe } from '../entities/me.mapper';

function userRow(overrides: Partial<User> = {}): User {
  const at = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'user-id-1',
    telegramId: 9_007_199_254_740_993n, // beyond Number.MAX_SAFE_INTEGER
    username: 'someone',
    firstName: 'Some',
    lastName: 'One',
    photoUrl: null,
    phone: null,
    locale: 'ru',
    referralCode: 'abcd1234',
    referredById: 'inviter-1',
    isBlocked: true,
    purchaseFrozen: true,
    botBlockedAt: at,
    createdAt: at,
    updatedAt: at,
    lastSeenAt: at,
    ...overrides,
  };
}

describe('toMe', () => {
  it('produces exactly the meSchema key set, with no extra fields', () => {
    const me = toMe(userRow());
    // strictObject rejects any key the contract does not list.
    expect(() => meSchema.strict().parse(me)).not.toThrow();
    expect(Object.keys(me).sort()).toEqual(Object.keys(meSchema.shape).sort());
  });

  it('serialises telegramId as a lossless string', () => {
    expect(toMe(userRow()).telegramId).toBe('9007199254740993');
  });

  it('never exposes internal fields', () => {
    const me: Record<string, unknown> = { ...toMe(userRow({ phone: 'linked' })) };
    for (const key of ['phone', 'isBlocked', 'purchaseFrozen', 'botBlockedAt', 'referredById']) {
      expect(me).not.toHaveProperty(key);
    }
  });

  it('maps phone to phoneLinked', () => {
    expect(toMe(userRow({ phone: null })).phoneLinked).toBe(false);
    expect(toMe(userRow({ phone: 'linked' })).phoneLinked).toBe(true);
  });
});
