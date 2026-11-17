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
  error: z.object({ code: z.string(), details: z.unknown().optional() }),
});

const MAX_RETRY_AFTER_SEC = 3600;

/** `Retry-After` as delta-seconds or an HTTP date, capped at an hour. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  let seconds: number;
  if (/^\d{1,9}$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    if (!/^[A-Za-z]{3}, \d/.test(trimmed)) return undefined;
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    seconds = Math.ceil((at - nowMs) / 1000);
  }
  return Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER_SEC);
}

// A proxy answers without our envelope; the status still says something.
function codeFromStatus(status: number): ErrorCode {
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  return 'INTERNAL_ERROR';
}

export function errorFromResponse(response: TransportResponse, nowMs: number): ApiError {
  const failure = failureEnvelope.safeParse(response.body);
  return new ApiError({
    status: response.status,
    code: failure.success ? toKnownCode(failure.data.error.code) : codeFromStatus(response.status),
    details: failure.success ? failure.data.error.details : undefined,
    retryAfterSec: parseRetryAfter(response.retryAfter, nowMs),
    fromServer: failure.success,
  });
}

export interface ParsedResponse<T> {
  data: T;
  meta: PageMeta | undefined;
}

/**
 * Validates `data` with the endpoint's shared schema. A body that does not match is a contract
 * break, reported as INTERNAL_ERROR with the failing paths only (never the values: they may be
 * personal data).
 */
export function parseResponse<S extends z.ZodType>(
  response: TransportResponse,
  schema: S,
  nowMs: number,
): ParsedResponse<z.infer<S>> {
  if (response.status < 200 || response.status >= 300) throw errorFromResponse(response, nowMs);
  const envelope = successEnvelope.safeParse(response.body);
  if (!envelope.success) throw new ApiError({ status: response.status, code: 'INTERNAL_ERROR' });
  const data = schema.safeParse(envelope.data.data);
  if (!data.success) {
    const fields = data.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ApiError({ status: response.status, code: 'INTERNAL_ERROR', details: { fields } });
  }
  const meta = PageMetaSchema.safeParse(envelope.data.meta);
  return { data: data.data, meta: meta.success ? meta.data : undefined };
}
