import type { Page, Request, Route } from '@playwright/test';
import { API_PATTERN, USER } from '../support/fake-api';
import { installCatalogApi } from './catalog';

// A fake API for the Mini App shell: only `POST /auth/telegram/webapp` (and `GET /me`) exist. The
// browser never reaches a real API; every call is answered here, shaped like docs/04.

export type LoginAnswer =
  | { kind: 'ok'; user?: Partial<typeof USER>; token?: string }
  | { kind: 'error'; status: number; code: string }
  /** The connection fails, like a phone with no network. */
  | { kind: 'drop' };

export interface TgApi {
  /** The login answers in order; the last one repeats. */
  answers: LoginAnswer[];
  /** Every request the page sent to the API origin, in order. */
  requests: Request[];
  loginCalls: () => number;
  /** Holds the login until `release()` (to look at the splash). */
  hold: () => void;
  release: () => void;
}

export const TG_TOKEN = 'e2e-synthetic-tg-session-token';

const envelope = (data: unknown) => ({ success: true, data });
const failure = (code: string) => ({ success: false, error: { code, message: `errors.${code}` } });

export async function installTgApi(page: Page, answers: LoginAnswer[] = [{ kind: 'ok' }]) {
  let held: Promise<void> | null = null;
  let releaseHeld: () => void = () => undefined;
  let logins = 0;
  // The profile language: a PATCH /me changes what the next GET /me answers, like the server.
  let profileLocale: string = USER.locale;

  const api: TgApi = {
    answers,
    requests: [],
    loginCalls: () => logins,
    hold: () => {
      held = new Promise((resolve) => {
        releaseHeld = resolve;
      });
    },
    release: () => releaseHeld(),
  };

  const reply = async (route: Route, status: number, body: unknown) => {
    const origin = (await route.request().headerValue('origin')) ?? 'http://localhost:3100';
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': origin },
      body: JSON.stringify(body),
    });
  };

  await page.route(API_PATTERN, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    api.requests.push(request);

    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': (await request.headerValue('origin')) ?? '',
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers':
            'content-type,x-csrf-token,idempotency-key,accept,authorization',
        },
      });
      return;
    }

    if (request.method() === 'POST' && path === '/auth/telegram/webapp') {
      if (held) await held;
      const answer = api.answers[Math.min(logins, api.answers.length - 1)] ?? { kind: 'ok' };
      logins += 1;
      if (answer.kind === 'drop') {
        await route.abort('connectionfailed');
      } else if (answer.kind === 'error') {
        await reply(route, answer.status, failure(answer.code));
      } else {
        await reply(
          route,
          200,
          envelope({
            token: answer.token ?? TG_TOKEN,
            expiresIn: 3600,
            user: { ...USER, ...answer.user },
          }),
        );
      }
    } else if (request.method() === 'GET' && path === '/me') {
      const authorised = request.headers().authorization === `Bearer ${TG_TOKEN}`;
      await (authorised
        ? reply(route, 200, envelope({ ...USER, locale: profileLocale }))
        : reply(route, 401, failure('UNAUTHORIZED')));
    } else if (request.method() === 'PATCH' && path === '/me') {
      const authorised = request.headers().authorization === `Bearer ${TG_TOKEN}`;
      const body = request.postDataJSON() as { locale?: string };
      if (authorised) profileLocale = body.locale ?? profileLocale;
      await (authorised
        ? reply(route, 200, envelope({ ...USER, locale: profileLocale }))
        : reply(route, 401, failure('UNAUTHORIZED')));
    } else {
      await reply(route, 404, failure('NOT_FOUND'));
    }
  });

  // Layered on top: the catalog and the wallet answer, everything else falls through to the above.
  await installCatalogApi(page);

  return api;
}
