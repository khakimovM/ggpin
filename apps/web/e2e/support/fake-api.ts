import type { BrowserContext, Page, Route } from '@playwright/test';
import { installCatalogApi } from '../fixtures/catalog';

// A fake API for the sign-in and session journeys. The browser never reaches a real API: every
// request to the API origin is answered here with `page.route`, shaped like docs/04 (envelope,
// error codes, `details.attemptsLeft`). The OTP code cannot be read from a real run (the database
// holds only its HMAC), so the journeys use a fixed fake code.

export const API_ORIGIN = 'http://localhost:5000';
export const API_PATTERN = /^http:\/\/localhost:5000\/api\/v1\//;

export const NONCE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
export const BOT_URL = `https://t.me/ggpin_bot?start=login_${NONCE}`;
// Obviously fake: real-looking codes in test files trip secret scanners.
export const GOOD_CODE = '246810';
export const BAD_CODE = '111111';

export const USER = {
  id: 'user_1',
  telegramId: '123456789',
  username: 'sardor_r',
  firstName: 'Sardor',
  photoUrl: null,
  locale: 'uz',
  // The shape the bot's start parameter accepts: 8 lowercase letters or digits.
  referralCode: 'ref12345',
  phoneLinked: false,
};

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

export interface FakeSession {
  id: string;
  userAgent: string | null;
  ipMasked: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

export const SESSIONS: FakeSession[] = [
  {
    id: 'sess-current',
    userAgent: CHROME_WINDOWS,
    ipMasked: '203.0.113.x',
    createdAt: '2026-11-01T10:00:00.000Z',
    lastUsedAt: '2026-11-06T10:00:00.000Z',
    current: true,
  },
  {
    id: 'sess-iphone',
    userAgent: SAFARI_IPHONE,
    ipMasked: '198.51.100.x',
    createdAt: '2026-10-20T10:00:00.000Z',
    lastUsedAt: '2026-11-05T21:40:00.000Z',
    current: false,
  },
  {
    id: 'sess-mac',
    userAgent: SAFARI_MAC,
    ipMasked: '192.0.2.x',
    createdAt: '2026-10-10T10:00:00.000Z',
    lastUsedAt: '2026-11-04T08:15:00.000Z',
    current: false,
  },
];

export interface FakeApiOptions {
  signedIn?: boolean;
  /** Status answers in order; the last one repeats. */
  statuses?: ('PENDING' | 'CODE_SENT' | 'DENIED' | 'EXPIRED')[];
  /** `POST /auth/telegram/start` answers with this error instead of a nonce. */
  startFails?: { status: number; code: string; retryAfter?: number };
  /** Wrong codes the server accepts before it runs out of tries. */
  attempts?: number;
}

export interface FakeApi {
  signedIn: boolean;
  sessions: FakeSession[];
  /** `POST /auth/logout`: answered normally, or dropped like a lost connection. */
  logoutMode: 'ok' | 'drop';
  /** Ids whose `DELETE /auth/sessions/:id` answers 500 (the session stays). */
  revokeFails: Set<string>;
  calls: string[];
  /** Number of calls to `<METHOD> <path>` so far. */
  count: (call: string) => number;
}

const ok = (data: unknown) => ({ success: true, data });
const error = (code: string, details?: unknown) => ({
  success: false,
  error: { code, message: `errors.${code}`, details },
});

export async function installFakeApi(
  page: Page | BrowserContext,
  options: FakeApiOptions = {},
): Promise<FakeApi> {
  const statuses = options.statuses ?? ['PENDING', 'CODE_SENT'];
  let statusCalls = 0;
  let triesLeft = options.attempts ?? 5;
  // The profile language: a PATCH /me changes what the next GET /me answers, like the server.
  let profileLocale: string = USER.locale;
  const api: FakeApi = {
    signedIn: options.signedIn ?? false,
    sessions: SESSIONS.map((session) => ({ ...session })),
    logoutMode: 'ok',
    revokeFails: new Set(),
    calls: [],
    count: (call) => api.calls.filter((entry) => entry === call).length,
  };

  const answer = async (
    route: Route,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ) => {
    const origin = (await route.request().headerValue('origin')) ?? 'http://localhost:3100';
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        ...extra,
      },
      body: JSON.stringify(body),
    });
  };

  await page.route(API_PATTERN, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();

    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': (await request.headerValue('origin')) ?? '',
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type,x-csrf-token,idempotency-key,accept',
        },
      });
      return;
    }
    api.calls.push(
      `${method} ${path.replace(/\/sess-[a-z]+$/, '/:id').replace(/status\/.+$/, 'status/:nonce')}`,
    );

    if (method === 'POST' && path === '/auth/telegram/start') {
      const fail = options.startFails;
      if (fail) {
        const extra =
          fail.retryAfter === undefined
            ? ({} as Record<string, string>)
            : { 'retry-after': String(fail.retryAfter) };
        await answer(route, fail.status, error(fail.code), extra);
      } else {
        await answer(route, 200, ok({ nonce: NONCE, botUrl: BOT_URL }));
      }
    } else if (method === 'GET' && path.startsWith('/auth/telegram/status/')) {
      const status = statuses[Math.min(statusCalls, statuses.length - 1)];
      statusCalls += 1;
      await answer(route, 200, ok({ status }));
    } else if (method === 'POST' && path === '/auth/telegram/verify') {
      const body = request.postDataJSON() as { code?: string };
      if (body.code === GOOD_CODE) {
        api.signedIn = true;
        await answer(route, 200, ok({ user: USER }));
      } else {
        triesLeft -= 1;
        await answer(
          route,
          422,
          triesLeft <= 0
            ? error('CODE_EXPIRED')
            : error('CODE_INVALID', { attemptsLeft: triesLeft }),
        );
      }
    } else if (method === 'GET' && path === '/me') {
      await (api.signedIn
        ? answer(route, 200, ok({ ...USER, locale: profileLocale }))
        : answer(route, 401, error('UNAUTHORIZED')));
    } else if (method === 'PATCH' && path === '/me') {
      // The language choice (profile picker and header switch): saved, and echoed back.
      const body = request.postDataJSON() as { locale?: string };
      if (api.signedIn) profileLocale = body.locale ?? profileLocale;
      await (api.signedIn
        ? answer(route, 200, ok({ ...USER, locale: profileLocale }))
        : answer(route, 401, error('UNAUTHORIZED')));
    } else if (method === 'POST' && path === '/auth/refresh') {
      await answer(route, 401, error('UNAUTHORIZED'));
    } else if (method === 'GET' && path === '/auth/sessions') {
      await (api.signedIn
        ? answer(route, 200, ok(api.sessions))
        : answer(route, 401, error('UNAUTHORIZED')));
    } else if (method === 'DELETE' && path.startsWith('/auth/sessions/')) {
      const id = path.split('/').pop() ?? '';
      if (api.revokeFails.has(id)) {
        await answer(route, 500, error('INTERNAL_ERROR'));
        return;
      }
      api.sessions = api.sessions.filter((session) => session.id !== id);
      await answer(route, 200, ok({}));
    } else if (method === 'POST' && path === '/auth/logout') {
      if (api.logoutMode === 'drop') {
        await route.abort('connectionfailed');
      } else {
        api.signedIn = false;
        await answer(route, 200, ok({}));
      }
    } else {
      await answer(route, 404, error('NOT_FOUND'));
    }
  });

  // Layered on top: the catalog and the wallet answer, everything else falls through to the above.
  await installCatalogApi(page);

  return api;
}

/**
 * Console noise that is expected when a journey makes the fake API answer with an error: the
 * browser logs every 4xx/5xx subresource response. Anything else stays a failure.
 */
export const unexpectedProblems = (problems: string[]): string[] =>
  problems.filter(
    (line) => !/Failed to load resource: the server responded with a status of [45]\d\d/.test(line),
  );
