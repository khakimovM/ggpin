import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ERROR_HTTP_STATUS, errorMessageKey } from '@repo/shared';
import { requestLogger, routeOf, type LogRequest } from '../logging/request-logging';
import { resolveError } from './resolve-error';
import { toJsonSafe } from './to-json-safe';

// Structural subsets of the Fastify request/reply, so this file needs no direct `fastify`
// import (a transitive dependency of @nestjs/platform-fastify).
interface ErrorReply {
  status(statusCode: number): { send(payload: unknown): unknown };
}
// The Fastify request, as far as logging needs it (id, route, per-request logger).
type ErrorRequest = LogRequest;

// The single place errors become `{ success:false, error:{ code, message, details? } }`.
// Never echoes exception messages, stacks or driver text: for anything unexpected the client
// gets INTERNAL_ERROR and the cause stays in the server log.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<ErrorReply>();
    const request = http.getRequest<ErrorRequest>();
    const { code, details, log } = resolveError(exception);

    if (log) this.logFailure(exception, request);

    const error =
      details === undefined
        ? { code, message: errorMessageKey(code) }
        : { code, message: errorMessageKey(code), details: toJsonSafe(details) };
    void reply.status(ERROR_HTTP_STATUS[code]).send({ success: false, error });
  }
  // Method + route pattern + request id, then the error itself: no body, headers, query or
  // raw URL (they can embed ids or tokens). The stack stays here; the client never sees it.
  // Pino's err serializer redacts secrets in the message, stack and extra props (e.g. a
  // driver error that quotes a connection URL).
  private logFailure(exception: unknown, request: ErrorRequest): void {
    const log = requestLogger(request);
    const where = { method: request.method, route: routeOf(request) };
    if (exception instanceof Error) {
      log.error({ ...where, err: exception }, 'request failed');
    } else {
      log.error(where, 'request failed with a non-Error value');
    }
  }
}
