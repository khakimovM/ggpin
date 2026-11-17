import { AdminLoginVerifyBodySchema, LOGIN_NONCE_PATTERN } from '@repo/shared';
import {
  MOCK_ATTEMPTS,
  MOCK_BOT_USERNAME,
  MOCK_WRONG_CODE,
  meFixture,
  verifyFixture,
} from './fixtures';
import { readMockState, writeMockState } from './mock-state';
import { fail, ok, type MockRoute } from './router';

// `/admin/auth/*` as the real API behaves (docs/04 "Admin" — Auth), with the login's bot step
// simulated: a few PENDING polls, then CODE_SENT (or DENIED when the state says so).

interface PendingLogin {
  polls: number;
  attemptsLeft: number;
}

const logins = new Map<string, PendingLogin>();

function newNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const authRoutes: readonly MockRoute[] = [
  {
    method: 'POST',
    pattern: '/admin/auth/start',
    handler: () => {
      if (readMockState().startFails) return fail('INTERNAL_ERROR');
      const nonce = newNonce();
      logins.set(nonce, { polls: 0, attemptsLeft: MOCK_ATTEMPTS });
      return ok({ nonce, botUrl: `https://t.me/${MOCK_BOT_USERNAME}?start=admin_${nonce}` });
    },
  },
  {
    method: 'GET',
    pattern: '/admin/auth/status/:nonce',
    handler: ({ params }) => {
      const nonce = params.nonce ?? '';
      const login = logins.get(nonce);
      if (!LOGIN_NONCE_PATTERN.test(nonce) || login === undefined) return fail('NOT_FOUND');
      const state = readMockState();
      login.polls += 1;
      if (login.polls <= state.pendingPolls) return ok({ status: 'PENDING' });
      return ok({ status: state.deny ? 'DENIED' : 'CODE_SENT' });
    },
  },
  {
    method: 'POST',
    pattern: '/admin/auth/verify',
    handler: ({ body }) => {
      const parsed = AdminLoginVerifyBodySchema.safeParse(body);
      if (!parsed.success) return fail('VALIDATION_ERROR', { fields: [] });
      const login = logins.get(parsed.data.nonce);
      if (login === undefined || login.attemptsLeft <= 0) return fail('CODE_EXPIRED');
      if (parsed.data.code === MOCK_WRONG_CODE) {
        login.attemptsLeft -= 1;
        return login.attemptsLeft <= 0
          ? fail('CODE_EXPIRED')
          : fail('CODE_INVALID', { attemptsLeft: login.attemptsLeft });
      }
      logins.delete(parsed.data.nonce);
      const state = writeMockState({ signedIn: true });
      return ok(verifyFixture(state.role));
    },
  },
  {
    method: 'POST',
    pattern: '/admin/auth/logout',
    handler: () => {
      if (!readMockState().signedIn) return fail('NOT_FOUND');
      writeMockState({ signedIn: false });
      return ok({});
    },
  },
  {
    method: 'GET',
    pattern: '/admin/auth/me',
    handler: ({ now }) => {
      const state = readMockState();
      return state.signedIn ? ok(meFixture(state.role, now)) : fail('NOT_FOUND');
    },
  },
];
