import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ERROR_HTTP_STATUS, errorMessageKey } from '@repo/shared';
import { resolveError } from './resolve-error';
import { toJsonSafe } from './to-json-safe';

// Structural subsets of the Fastify request/reply, so this file needs no direct `fastify`
// import (a transitive dependency of @nestjs/platform-fastify).
interface ErrorReply {
  status(statusCode: number): { send(payload: unknown): unknown };
}
interface ErrorRequest {
  readonly method: string;
  readonly routeOptions?: { readonly url?: string };
}

// The single place errors become `{ success:false, error:{ code, message, details? } }`.
// Never echoes exception messages, stacks or driver text: for anything unexpected the client
// gets INTERNAL_ERROR and the cause stays in the server log.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

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

  // Method + route pattern only: no body, headers, query or raw URL (which can embed ids or
  // tokens). S6 replaces this logger with Pino and adds redaction.
  private logFailure(exception: unknown, request: ErrorRequest): void {
    const route = request.routeOptions?.url ?? 'unmatched';
    const where = `${request.method} ${route}`;
    if (exception instanceof Error) {
      this.logger.error(`${where} failed: ${exception.name}`, exception.stack);
    } else {
      this.logger.error(`${where} failed with a non-Error value`);
    }
  }
}
