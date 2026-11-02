import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { AppError } from '../../exceptions/app-error';
import type { AuthUser } from '../auth-user';
import { CurrentUser } from '../current-user.decorator';
import { fakeContext, fakeRequest } from './guard-context';

// Reads the factory Nest stored for a parameter decorator, so it runs exactly as in a request.
function resolve(field: keyof AuthUser | undefined, user: AuthUser | undefined): unknown {
  class Probe {
    handle(@CurrentUser(field) _value: unknown): void {}
  }
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handle') as Record<
    string,
    { factory: (data: unknown, ctx: unknown) => unknown; data: unknown }
  >;
  const entry = Object.values(meta)[0];
  if (entry === undefined) throw new Error('decorator metadata missing');
  const { context } = fakeContext(fakeRequest(user === undefined ? {} : { authUser: user }));
  return entry.factory(entry.data, context);
}

const user: AuthUser = { id: 'u1', telegramId: 9n, channel: 'tg' };

describe('@CurrentUser', () => {
  it('returns the whole object, or one field', () => {
    expect(resolve(undefined, user)).toBe(user);
    expect(resolve('id', user)).toBe('u1');
    expect(resolve('channel', user)).toBe('tg');
  });

  it('fails closed (UNAUTHORIZED) when no session was attached', () => {
    expect(() => resolve('id', undefined)).toThrow(AppError);
  });
});
