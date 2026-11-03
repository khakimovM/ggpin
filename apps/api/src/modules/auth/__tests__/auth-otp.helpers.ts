import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME } from '@repo/shared';
import { UsersService } from '../../users/users.service';
import { OtpLoginService } from '../otp-login.service';
import type { AuthE2e } from './auth-e2e.helpers';

export type Res = Awaited<ReturnType<AuthE2e['get']>>;
export interface Envelope {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; details?: Record<string, unknown> };
}
export const bodyOf = (res: Res): Envelope => res.json<Envelope>();

export const START = '/api/v1/auth/telegram/start';
export const VERIFY = '/api/v1/auth/telegram/verify';
export const statusUrl = (nonce: string): string => `/api/v1/auth/telegram/status/${nonce}`;
export const REFRESH = '/api/v1/auth/refresh';
export const LOGOUT = '/api/v1/auth/logout';
export const SESSIONS = '/api/v1/auth/sessions';
export const ME = '/api/v1/me';

export interface TestUser {
  readonly userId: string;
  readonly telegramId: number;
}

export async function makeUser(t: AuthE2e): Promise<TestUser> {
  const telegramId = t.newTelegramId();
  const { user } = await t
    .app()
    .get(UsersService)
    .ensureTelegramUser(
      { telegramId: BigInt(telegramId), firstName: 'Otp' },
      { now: t.clock.now() },
    );
  return { userId: user.id, telegramId };
}

/** What the bot does: a login request is started on the web, then the bot hands out the code. */
export async function startNonce(t: AuthE2e): Promise<string> {
  const { nonce } = await t.app().get(OtpLoginService).start(t.clock.now());
  t.trackNonce(nonce);
  return nonce;
}

export async function botIssue(t: AuthE2e, nonce: string, telegramId: number): Promise<string> {
  const result = await t
    .app()
    .get(OtpLoginService)
    .issueCode({ nonce, telegramId: BigInt(telegramId), now: t.clock.now() });
  if (!result.ok) throw new Error(`issueCode refused: ${result.reason}`);
  return result.code;
}

export function verify(
  t: AuthE2e,
  nonce: string,
  code: string,
  headers: Record<string, string> = {},
  ip: string = t.nextIp(),
): Promise<Res> {
  return t.post(VERIFY, { nonce, code }, { ...t.csrfHeaders, ...headers }, ip);
}

/** Set-Cookie header values, as the browser would receive them. */
export function setCookies(res: Res): string[] {
  const raw = res.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export function cookieValue(res: Res, name: string): string {
  const line = setCookies(res).find((c) => c.startsWith(`${name}=`));
  if (line === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return line.slice(name.length + 1).split(';')[0] ?? '';
}

export interface LoggedIn {
  readonly user: TestUser;
  readonly nonce: string;
  readonly access: string;
  readonly refresh: string;
  readonly familyId: string;
  /** Cookie header as the browser sends it to /api/v1/auth/*. */
  readonly cookie: string;
  /** Cookie header with only the access token (any non-auth route). */
  readonly accessCookie: string;
}

export function cookiesFrom(access: string, refresh: string): LoggedIn['cookie'] {
  return `${ACCESS_COOKIE_NAME}=${access}; ${REFRESH_COOKIE_NAME}=${refresh}`;
}

/** The whole journey through HTTP for an existing user: start, bot code, verify. */
export async function loginAs(
  t: AuthE2e,
  user: TestUser,
  headers: Record<string, string> = {},
): Promise<LoggedIn> {
  const nonce = await startNonce(t);
  const code = await botIssue(t, nonce, user.telegramId);
  const res = await verify(t, nonce, code, headers);
  if (res.statusCode !== 200) throw new Error(`verify failed: ${res.body}`);
  const access = cookieValue(res, ACCESS_COOKIE_NAME);
  const refresh = cookieValue(res, REFRESH_COOKIE_NAME);
  const claims = t.codec.verify(access, 'web', t.clock.now());
  if (claims?.sid === undefined) throw new Error('access token has no sid');
  return {
    user,
    nonce,
    access,
    refresh,
    familyId: claims.sid,
    cookie: cookiesFrom(access, refresh),
    accessCookie: `${ACCESS_COOKIE_NAME}=${access}`,
  };
}
