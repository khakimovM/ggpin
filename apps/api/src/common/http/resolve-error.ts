import { HttpException } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import type { ErrorCode } from '@repo/shared';
import { AppError } from '../exceptions/app-error';

export interface ResolvedError {
  readonly code: ErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
  /** Server-side problem worth a log line (500s and unmapped statuses). */
  readonly log: boolean;
}

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
}

// Only statuses that have a contract code (docs/04 "Xato kodlari"). Every other status
// becomes INTERNAL_ERROR rather than an invented code; the filter logs the original status
// so a missing mapping is noticed. 415 is folded into VALIDATION_ERROR: from the client's
// point of view the request was malformed, and the contract has no 415 code.
const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
};

function fromStatus(status: number): ResolvedError {
  const code = STATUS_TO_CODE[status];
  return code === undefined
    ? { code: 'INTERNAL_ERROR', log: true }
    : { code, log: code === 'INTERNAL_ERROR' };
}

// Zod issues carry the rejected input in some fields (`input`, `received`) and messages that
// can quote allowed values. Only the path and the issue code leave the server.
function toFieldIssues(error: unknown): FieldIssue[] {
  if (typeof error !== 'object' || error === null || !('issues' in error)) return [];
  const { issues } = error;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown): FieldIssue[] => {
    if (typeof issue !== 'object' || issue === null) return [];
    const path = 'path' in issue && Array.isArray(issue.path) ? issue.path : [];
    const code = 'code' in issue && typeof issue.code === 'string' ? issue.code : 'invalid';
    return [{ path: path.map(String).join('.'), code }];
  });
}

// Fastify's own errors (body too large, malformed JSON, unsupported media type) carry a
// numeric statusCode and a FST_ERR_* code; they are not Nest HttpExceptions.
function isFastifyError(error: unknown): error is { statusCode: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('FST_ERR_')
  );
}

export function resolveError(exception: unknown): ResolvedError {
  if (exception instanceof AppError) {
    return {
      code: exception.code,
      details: exception.details,
      log: exception.code === 'INTERNAL_ERROR',
    };
  }
  if (exception instanceof ZodValidationException) {
    return {
      code: 'VALIDATION_ERROR',
      details: { fields: toFieldIssues(exception.getZodError()) },
      log: false,
    };
  }
  if (exception instanceof HttpException) return fromStatus(exception.getStatus());
  if (isFastifyError(exception)) return fromStatus(exception.statusCode);
  return { code: 'INTERNAL_ERROR', log: true };
}
