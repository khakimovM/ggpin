import { CSRF_HEADER, webAppLoginResponseSchema } from '@repo/shared';
import { expect, type APIRequestContext } from '@playwright/test';
import type { z } from 'zod';
import { errorFromResponse, parseResponse, type ParsedResponse } from '../../src/lib/api/envelope';
import type { ApiError } from '../../src/lib/api/errors';
import type { TransportResponse } from '../../src/lib/api/transport';
import { E2E_BOT_TOKEN, signInitData } from '../fixtures/telegram';
import { API_BASE } from './real-api';

// Talking to the REAL API from a spec, and reading its answers with the web app's OWN envelope
// parser (src/lib/api/envelope.ts) and the shared schemas the web uses: a response that passes here
// is one the web would accept, a failure here is a contract break.

// Telegram ids of the journeys: `Date.now() * 1000 + n`, about 1.7e15. That is below 2^53 (the API
// takes a safe integer) and far above any id Telegram has issued, so no run ever signs in as a real
// person's account, and two runs never share an id (the database keeps its users between runs).
const ID_SEED = Date.now() * 1000;
let idSeq = 0;
export const nextTelegramId = (): number => ID_SEED + ++idSeq;

export interface Session {
  telegramId: number;
  userId: string;
  /** The Mini App session token (Bearer). Kept in memory only, as the app does. */
  token: string;
}

export interface RealResponse extends TransportResponse {
  headers: Readonly<Record<string, string>>;
}

/** A Mini App sign-in made straight against the API (what `/tg` does with the signed launch data). */
export async function signInReal(
  request: APIRequestContext,
  telegramId: number,
  language: 'uz' | 'ru' = 'uz',
): Promise<Session> {
  const initData = signInitData(
    { user: { id: telegramId, first_name: `Payer${telegramId}`, language_code: language } },
    E2E_BOT_TOKEN,
  );
  const response = await request.post(`${API_BASE}/auth/telegram/webapp`, {
    // The API's CSRF check wants the header and an allowed Origin (a browser adds the latter).
    headers: { [CSRF_HEADER]: '1', origin: 'http://localhost:3100' },
    data: { initData },
  });
  expect(response.status()).toBe(200);
  const { data } = parseResponse(
    { status: response.status(), retryAfter: null, body: await response.json() },
    webAppLoginResponseSchema,
    Date.now(),
  );
  return { telegramId, userId: data.user.id, token: data.token };
}

export interface SendOptions {
  session?: Session;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function send(
  request: APIRequestContext,
  method: 'GET' | 'POST',
  path: string,
  options: SendOptions = {},
): Promise<RealResponse> {
  const headers = { ...options.headers };
  if (options.session !== undefined) headers.authorization = `Bearer ${options.session.token}`;
  const response = await request.fetch(`${API_BASE}${path}`, {
    method,
    headers,
    data: options.body,
    // A 3xx would be a different endpoint answering: the web client refuses redirects too.
    maxRedirects: 0,
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }
  return {
    status: response.status(),
    retryAfter: response.headers()['retry-after'] ?? null,
    body,
    headers: response.headers(),
  };
}

/** The web's parse of a success answer: throws (a contract break) when the schema does not fit. */
export function parsed<S extends z.ZodType>(
  response: RealResponse,
  schema: S,
  expectedStatus = 200,
): ParsedResponse<z.infer<S>> {
  expect(response.status).toBe(expectedStatus);
  return parseResponse(response, schema, Date.now());
}

/** The web's reading of a failure: its ApiError, so the status, code, details and wait are checked. */
export function failed(response: RealResponse, status: number, code: string): ApiError {
  expect(response.status).toBe(status);
  const error = errorFromResponse(response, Date.now());
  expect(error.code).toBe(code);
  expect(error.fromServer).toBe(true);
  return error;
}

/** `Cache-Control: no-store`: a response with money or a card must never be cached (docs/04). */
export function expectNoStore(response: RealResponse): void {
  expect(response.headers['cache-control']).toMatch(/no-store/);
}
