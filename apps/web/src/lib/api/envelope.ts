// Turns a wire response into validated data or an ApiError (docs/04 envelope).
import { PageMetaSchema, type ErrorCode, type PageMeta } from '@repo/shared';
import { z } from 'zod';
import { ApiError, toKnownCode } from './errors';
import type { TransportResponse } from './transport';

const successEnvelope = z.object({
  success: z.literal(true),
  data: z.unknown(),
  meta: z.unknown().optional(),
});
const failureEnvelope = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    details: z.unknown().optional(),
  }),
});

const MAX_RETRY_AFTER_SEC = 3600;

/**
 * `Retry-After` is delta-seconds or an HTTP date. Capped at an hour so a bad header cannot
 * freeze a button for a day.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  let seconds: number;
  if (/^\d{1,9}$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    // IMF-fixdate ("Thu, 05 Nov 2026 10:01:30 GMT"); Date.parse alone also accepts things like "-5".
    if (!/^[A-Za-z]{3}, \d/.test(trimmed)) return undefined;
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    seconds = Math.ceil((at - nowMs) / 1000);
  }
  return Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER_SEC);
}

// A proxy or gateway answers without our envelope; the status still says something useful.
function codeFromStatus(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  return 'INTERNAL_ERROR';
}

export function errorFromResponse(response: TransportResponse, nowMs: number): ApiError {
  const failure = failureEnvelope.safeParse(response.body);
  const code = failure.success
    ? toKnownCode(failure.data.error.code)
    : codeFromStatus(response.status);
  return new ApiError({
    status: response.status,
    code,
    details: failure.success ? failure.data.error.details : undefined,
    retryAfterSec: parseRetryAfter(response.retryAfter, nowMs),
  });
}

export interface ParsedResponse<T> {
  data: T;
  meta: PageMeta | undefined;
}

/**
 * Validates `data` with the endpoint's shared schema. A body that does not match is a contract
 * break between client and server, reported as INTERNAL_ERROR; the payload itself is never put
 * into the error (it may hold personal data).
 */
export function parseResponse<S extends z.ZodType>(
  response: TransportResponse,
  schema: S,
  nowMs: number,
): ParsedResponse<z.infer<S>> {
  if (response.status < 200 || response.status >= 300) throw errorFromResponse(response, nowMs);

  const envelope = successEnvelope.safeParse(response.body);
  // 204 has no body; the endpoint's schema decides whether `undefined` is acceptable.
  if (!envelope.success && response.status !== 204) {
    throw new ApiError({ status: response.status, code: 'INTERNAL_ERROR' });
  }
  const rawData = envelope.success ? envelope.data.data : undefined;

  const data = schema.safeParse(rawData);
  if (!data.success) {
    // Only the field paths are kept: enough to debug the mismatch, no values.
    const fields = data.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ApiError({ status: response.status, code: 'INTERNAL_ERROR', details: { fields } });
  }
  const meta = envelope.success ? PageMetaSchema.safeParse(envelope.data.meta) : undefined;
  return { data: data.data, meta: meta?.success ? meta.data : undefined };
}
