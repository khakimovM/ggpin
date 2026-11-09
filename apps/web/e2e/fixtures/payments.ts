import type { BrowserContext, Page, Route } from '@playwright/test';

// A fake of the P2P top-up endpoints, shaped like docs/04 "To'lovlar (P2P)": methods, intents,
// cancel, pay-link and the public pay view with its capability token. One request ("intent") at a
// time, as on the server; the test moves it between statuses with `setStatus`.

const PAYMENTS = /^http:\/\/localhost:5000\/api\/v1\/payments\/(.*)$/;

export const INTENT_ID = 'cm3intent00000000000000001';
/** A 43-character base64url value: the shape of a real token, not a real one. */
export const PAY_TOKEN = `e2ePayToken${'A'.repeat(31)}1`;
export const PAY_TOKEN_2 = `e2ePayToken${'B'.repeat(31)}2`;
export const BASE_TIYIN = '5000000'; // 50 000 so'm
export const PAY_TIYIN = '5034700'; // + 347 so'm: the exact amount to send

export type IntentStatus = 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
export type CreateMode =
  | 'ok'
  | 'pending'
  | 'conflict'
  | 'blocked'
  | 'range'
  | 'dailyDone'
  | 'rateLimited'
  | 'unavailable'
  | 'networkOnce';
export type PayViewMode = 'ok' | 'notFound' | 'error';

export interface PaymentsApiOptions {
  methods?: 'ok' | 'unavailable' | 'error';
  create?: CreateMode;
  /** Seconds until the request expires (30 minutes by default). */
  ttlSec?: number;
  /** A waiting request exists before the test starts. */
  preset?: boolean;
  /** The ownerHint of the pay view (null = none). */
  ownerHint?: string | null;
  payView?: PayViewMode;
  /** The id the fake hands out (default INTENT_ID). */
  intentId?: string;
  /** What a PAID request says was credited (default: the pay amount). */
  creditedTiyin?: string;
  /** `foreign`: the API names a pay link on another origin (it must never be opened). */
  redirect?: 'ours' | 'foreign';
}

export interface PaymentsApi {
  /** Every `POST /payments/intents`: the amount, the bank and the Idempotency-Key. */
  creates: Array<{ amountTiyin: string; bank: string | null; key: string | null }>;
  /** What the public pay view saw: the token header, and whether a cookie travelled. */
  payViews: Array<{ token: string | null; url: string; cookie: boolean }>;
  cancels: () => number;
  payLinks: () => number;
  status: () => IntentStatus;
  setStatus: (status: IntentStatus) => void;
  setPayView: (mode: PayViewMode) => void;
  setCreate: (mode: CreateMode) => void;
  /** Starts a waiting request now (as if created elsewhere). */
  startIntent: (ttlSec?: number) => void;
  /** Every URL the page asked for that is not ours (a third-party request would be a bug). */
  requested: string[];
}

const envelope = (data: unknown) => ({ success: true, data });
const failure = (code: string, details?: unknown) => ({
  success: false,
  error: { code, message: `errors.${code}`, ...(details === undefined ? {} : { details }) },
});

export async function installPaymentsApi(
  page: Page | BrowserContext,
  options: PaymentsApiOptions = {},
): Promise<PaymentsApi> {
  const id = options.intentId ?? INTENT_ID;
  let createMode: CreateMode = options.create ?? 'ok';
  let payViewMode: PayViewMode = options.payView ?? 'ok';
  let status: IntentStatus = 'PENDING';
  let exists = options.preset ?? false;
  let expiresAt = Date.now() + (options.ttlSec ?? 1800) * 1000;
  let token = PAY_TOKEN;
  let droppedOnce = false;
  let cancels = 0;
  let payLinks = 0;
  const api: PaymentsApi = {
    creates: [],
    payViews: [],
    requested: [],
    cancels: () => cancels,
    payLinks: () => payLinks,
    status: () => status,
    setStatus: (next) => {
      status = next;
    },
    setPayView: (mode) => {
      payViewMode = mode;
    },
    setCreate: (mode) => {
      createMode = mode;
    },
    startIntent: (ttlSec = 1800) => {
      exists = true;
      status = 'PENDING';
      expiresAt = Date.now() + ttlSec * 1000;
    },
  };

  const reply = async (route: Route, httpStatus: number, body: unknown, extra = {}) => {
    const origin = (await route.request().headerValue('origin')) ?? 'http://localhost:3100';
    await route.fulfill({
      status: httpStatus,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'Retry-After',
        'cache-control': 'no-store',
        ...extra,
      },
      body: JSON.stringify(body),
    });
  };

  const card = { bank: 'HUMO', number: '9860123456789012', holderName: 'ALISHER K.' };
  const view = () => ({
    intentId: id,
    status,
    baseAmountTiyin: BASE_TIYIN,
    payAmountTiyin: PAY_TIYIN,
    card: status === 'PENDING' ? card : null,
    expiresAt: new Date(expiresAt).toISOString(),
    currency: 'UZS',
  });
  const intent = () => ({
    ...view(),
    paidAt: status === 'PAID' ? new Date().toISOString() : null,
    creditedTiyin: status === 'PAID' ? (options.creditedTiyin ?? PAY_TIYIN) : null,
  });
  const link = (locale: string) =>
    `${options.redirect === 'foreign' ? 'https://evil.example' : 'http://localhost:3100'}/pay/${id}?locale=${locale}#t=${token}`;

  await page.route(PAYMENTS, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/payments/', '');
    const method = request.method();

    if (method === 'GET' && path === 'methods') {
      if (options.methods === 'error') return reply(route, 500, failure('INTERNAL_ERROR'));
      return reply(
        route,
        200,
        envelope([
          {
            code: 'P2P_CARD',
            available: options.methods !== 'unavailable',
            banks: [
              { bank: 'HUMO', available: true },
              { bank: 'UZCARD', available: true },
            ],
            minTiyin: '500000',
            maxTiyin: '200000000',
            stepTiyin: '100000',
          },
        ]),
      );
    }

    if (method === 'POST' && path === 'intents') {
      const body = request.postDataJSON() as { amountTiyin: string; bank?: string };
      api.creates.push({
        amountTiyin: body.amountTiyin,
        bank: body.bank ?? null,
        key: (await request.headerValue('idempotency-key')) ?? null,
      });
      if (createMode === 'networkOnce' && !droppedOnce) {
        droppedOnce = true;
        return route.abort('connectionfailed');
      }
      if (createMode === 'pending') {
        if (!exists) {
          exists = true;
          expiresAt = Date.now() + 1260 * 1000;
        }
        return reply(route, 409, failure('TOPUP_ALREADY_PENDING', { intentId: id }));
      }
      if (createMode === 'conflict') {
        return reply(route, 409, failure('IDEMPOTENCY_CONFLICT', { intentId: id }));
      }
      if (createMode === 'blocked') return reply(route, 403, failure('USER_BLOCKED'));
      if (createMode === 'range') {
        return reply(
          route,
          422,
          failure('TOPUP_AMOUNT_OUT_OF_RANGE', {
            min: '500000',
            max: '200000000',
            step: '100000',
          }),
        );
      }
      if (createMode === 'dailyDone') {
        return reply(
          route,
          422,
          failure('TOPUP_AMOUNT_OUT_OF_RANGE', {
            min: '500000',
            max: '0',
            step: '100000',
            reason: 'NEW_ACCOUNT_DAILY_LIMIT',
          }),
        );
      }
      if (createMode === 'rateLimited') {
        return reply(route, 429, failure('RATE_LIMITED'), { 'retry-after': '30' });
      }
      if (createMode === 'unavailable') {
        return reply(route, 503, failure('PAYMENT_METHOD_UNAVAILABLE'));
      }
      exists = true;
      status = 'PENDING';
      expiresAt = Date.now() + (options.ttlSec ?? 1800) * 1000;
      token = PAY_TOKEN;
      return reply(
        route,
        201,
        envelope({
          ...view(),
          status: 'PENDING',
          card,
          redirectUrl: link('uz'),
        }),
      );
    }

    if (method === 'GET' && path === 'intents') {
      const wanted = url.searchParams.get('status');
      const live = exists && (wanted === null || wanted === status);
      return reply(route, 200, envelope(live ? [intent()] : []));
    }

    if (method === 'GET' && path === `intents/${id}`) {
      return exists
        ? reply(route, 200, envelope(intent()))
        : reply(route, 404, failure('NOT_FOUND'));
    }

    if (method === 'POST' && path === `intents/${id}/cancel`) {
      cancels += 1;
      status = 'CANCELLED';
      return reply(route, 200, envelope({ intentId: id, status: 'CANCELLED' }));
    }

    if (method === 'POST' && path === `intents/${id}/pay-link`) {
      payLinks += 1;
      token = PAY_TOKEN_2;
      return reply(
        route,
        200,
        envelope({ redirectUrl: link('uz'), expiresAt: new Date(expiresAt).toISOString() }),
      );
    }

    if (method === 'GET' && path === `pay/${id}`) {
      const headers = request.headers();
      api.payViews.push({
        token: headers['x-pay-token'] ?? null,
        url: request.url(),
        cookie: 'cookie' in headers,
      });
      if (payViewMode === 'error') return reply(route, 503, failure('INTERNAL_ERROR'));
      const valid = payViewMode === 'ok' && headers['x-pay-token'] === token;
      if (!valid) return reply(route, 404, failure('NOT_FOUND'));
      return reply(
        route,
        200,
        envelope({
          ...view(),
          ownerHint: options.ownerHint === undefined ? 'S***r' : options.ownerHint,
        }),
      );
    }

    // Any other request of the visitor's: not theirs, or not there (uniform 404).
    if (path.startsWith('intents/') || path.startsWith('pay/')) {
      return reply(route, 404, failure('NOT_FOUND'));
    }
    return route.fallback();
  });

  // A page that asks for anything outside this site and the fake API leaks (CDN, analytics).
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (!/^(http:\/\/localhost:(3100|5000)\/|data:|blob:)/.test(url)) api.requested.push(url);
    return route.fallback();
  });

  return api;
}
