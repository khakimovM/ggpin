import {
  CancelTopupIntentResponseSchema,
  PAY_TOKEN_HEADER,
  PAY_TOKEN_PATTERN,
  PayLinkResponseSchema,
  PayViewSchema,
  PaymentMethodsResponseSchema,
  TopupIntentCreatedSchema,
  TopupIntentSchema,
  type CancelTopupIntentResponse,
  type CreateTopupIntentBody,
  type IntentListQuery,
  type PayLinkResponse,
  type PayView,
  type PaymentMethodsResponse,
  type TopupIntent,
  type TopupIntentCreated,
} from '@repo/shared';
import { apiFetch } from './client';
import { ApiError } from './errors';
import { resourceId } from './path';

// P2P card top-up (docs/04 "To‘lovlar (P2P karta)"). Shapes come straight from @repo/shared.

export type IntentFilters = Partial<Pick<IntentListQuery, 'status'>> & { limit?: number };

export function getPaymentMethods(signal?: AbortSignal): Promise<PaymentMethodsResponse> {
  return apiFetch(
    { path: '/payments/methods', group: 'payments', signal },
    PaymentMethodsResponseSchema,
  );
}

/** One `idempotencyKey` per top-up attempt: a retry must return the same request, not a second. */
export function createTopupIntent(
  body: CreateTopupIntentBody,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<TopupIntentCreated> {
  return apiFetch(
    { method: 'POST', path: '/payments/intents', body, idempotencyKey, group: 'payments', signal },
    TopupIntentCreatedSchema,
  );
}

/** Own requests, newest first. Not paginated: docs/04 answers a plain array without `meta`. */
export function listTopupIntents(
  filters: IntentFilters = {},
  signal?: AbortSignal,
): Promise<TopupIntent[]> {
  return apiFetch(
    { path: '/payments/intents', query: { ...filters }, group: 'payments', signal },
    TopupIntentSchema.array(),
  );
}

export async function getTopupIntent(id: string, signal?: AbortSignal): Promise<TopupIntent> {
  return apiFetch(
    { path: `/payments/intents/${resourceId(id)}`, group: 'payments', signal },
    TopupIntentSchema,
  );
}

export async function cancelTopupIntent(id: string): Promise<CancelTopupIntentResponse> {
  return apiFetch(
    {
      method: 'POST',
      path: `/payments/intents/${resourceId(id)}/cancel`,
      body: {},
      group: 'payments',
    },
    CancelTopupIntentResponseSchema,
  );
}

/** A fresh pay link; the previous one stops working. */
export async function createPayLink(id: string): Promise<PayLinkResponse> {
  return apiFetch(
    {
      method: 'POST',
      path: `/payments/intents/${resourceId(id)}/pay-link`,
      body: {},
      group: 'payments',
    },
    PayLinkResponseSchema,
  );
}

/**
 * Pay page endpoint (public, capability token in the `X-Pay-Token` header).
 *
 * Link format: `${WEB_URL}/pay/<intentId>?locale=<uz|ru>#t=<token>`. The token lives only in
 * the URL fragment; the one allowed query parameter is the page language. The page itself is
 * built in phase 7 S8 (D-50) and does this:
 *   1. the language comes from the DECODED query (`payLocaleOf`, one rule for the middleware and
 *      the page) and the token from `readPayTokenFromHash(location.hash)`, read before hydration;
 *   2. `#t=` is removed with `router.replace(pathname + search, { scroll: false })` while KEEPING
 *      `?locale=` (a bare `history.replaceState` lets Next put the fragment back);
 *   3. the token is kept for THIS TAB only: in memory and in `sessionStorage` (`ggpin:pay:<id>`,
 *      one token per tab, erased when the request ends or the server stops knowing it), never in
 *      `localStorage`, cookies, logs or the query cache key; it is passed to `getPayView`, which
 *      sends it as the `X-Pay-Token` header.
 * S8 Playwright requirement: after load, after `router.refresh()` and after a language switch
 * the URL has no `#t=`.
 */
export const PAY_DISPLAY_PATH = (intentId: string): string =>
  `/payments/pay/${resourceId(intentId)}`;

export async function getPayView(
  intentId: string,
  payToken: string,
  signal?: AbortSignal,
): Promise<PayView> {
  // The API answers every bad token with the same 404; a malformed one is not worth a request.
  if (!PAY_TOKEN_PATTERN.test(payToken)) throw new ApiError({ status: 404, code: 'NOT_FOUND' });
  return apiFetch(
    {
      path: PAY_DISPLAY_PATH(intentId),
      headers: { [PAY_TOKEN_HEADER]: payToken },
      session: 'anonymous',
      group: 'payments',
      // Per-request state behind a capability token: never from, or into, an HTTP cache.
      cache: 'no-store',
      signal,
    },
    PayViewSchema,
  );
}
