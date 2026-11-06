import type { Me } from '@repo/shared';
import { createApiClient, type ApiClient } from '../http';
import type { AuthStrategy } from '../auth-strategy';
import type { Transport, TransportRequest, TransportResponse } from '../transport';

/** A fixed, obviously fake key: real-looking random UUIDs in tests trip secret scanners. */
export const TEST_IDEMPOTENCY_KEY = '00000000-0000-4000-8000-000000000001';

export const BASE = 'http://localhost:5000/api/v1';

export const ME: Me = {
  id: 'user_1',
  telegramId: '123456789',
  username: null,
  firstName: 'Aziz',
  photoUrl: null,
  locale: 'uz',
  referralCode: 'REF123',
  phoneLinked: false,
};

export const success = (data: unknown, meta?: unknown): TransportResponse => ({
  status: 200,
  retryAfter: null,
  body: { success: true, data, ...(meta === undefined ? {} : { meta }) },
});

export const failure = (
  status: number,
  code: string,
  details?: unknown,
  retryAfter: string | null = null,
): TransportResponse => ({
  status,
  retryAfter,
  body: { success: false, error: { code, message: `errors.${code}`, details } },
});

export type Script = (
  request: TransportRequest,
  index: number,
) => TransportResponse | Promise<TransportResponse>;

/** A transport driven by a function; every request it sees is recorded. */
export function scripted(script: Script): { transport: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    calls.push(request);
    return script(request, calls.length - 1);
  };
  return { transport, calls };
}

export function clientFor(
  transport: Transport,
  strategy: AuthStrategy,
  now?: () => number,
): ApiClient {
  return createApiClient({
    baseUrl: BASE,
    getStrategy: () => strategy,
    transportFor: () => Promise.resolve(transport),
    now,
  });
}

export const pathOf = (request: TransportRequest): string => new URL(request.url).pathname;

/** Lets pending promise chains settle so parallel requests interleave deterministically. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
