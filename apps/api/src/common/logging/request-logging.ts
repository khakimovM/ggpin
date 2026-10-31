import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PinoLogger } from 'nestjs-pino';
import type { Logger } from 'pino';
import { REQUEST_ID_HEADER } from './request-id';
import { pathWithoutQuery } from './serializers';

/** The slice of a Fastify request the logging code reads (structural: no direct fastify import). */
export interface LogRequest {
  readonly id: string;
  readonly method: string;
  readonly ip: string;
  readonly url: string;
  readonly is404: boolean;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly routeOptions?: { readonly url?: string };
  readonly raw: { readonly allLogs?: readonly Logger[] };
}

const HEALTH_PREFIX = '/api/v1/health';
const MAX_PATH_LENGTH = 128;
const MAX_USER_AGENT_LENGTH = 200;

/** The route pattern (`/api/v1/orders/:id`), never the raw URL: ids and tokens stay out. */
export function routeOf(request: LogRequest): string {
  return request.is404 ? 'unmatched' : (request.routeOptions?.url ?? 'unmatched');
}

// The per-request child logger (carries reqId) that pino-http builds for the raw request.
// Read from raw.allLogs, as nestjs-pino does: under Fastify, middie has already put Fastify's
// own (no-op) logger on req.log, and pino-http never overwrites an existing one. The
// fallback covers requests that never reached that middleware, so no line is ever written
// without a request id.
export function requestLogger(request: LogRequest): Logger {
  return request.raw.allLogs?.at(-1) ?? PinoLogger.root.child({ reqId: request.id });
}

function levelFor(status: number, route: string): 'debug' | 'info' | 'warn' | 'error' {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  // Probes poll every few seconds; their successes would drown the log.
  return route.startsWith(HEALTH_PREFIX) ? 'debug' : 'info';
}

function userAgentOf(request: LogRequest): string | undefined {
  const value = request.headers['user-agent'];
  return typeof value === 'string' ? value.slice(0, MAX_USER_AGENT_LENGTH) : undefined;
}

export function logRequestCompleted(
  request: LogRequest,
  reply: { readonly statusCode: number; readonly elapsedTime: number },
): void {
  const route = routeOf(request);
  const record: Record<string, unknown> = {
    method: request.method,
    route,
    status: reply.statusCode,
    durationMs: Math.round(reply.elapsedTime),
    ip: request.ip,
    userAgent: userAgentOf(request),
  };
  // An unmatched path is a scanner or a client bug; knowing which is useful. Matched routes
  // already have their pattern, and the query string is cut in both cases.
  if (route === 'unmatched') {
    record.path = pathWithoutQuery(request.url).slice(0, MAX_PATH_LENGTH);
  }
  requestLogger(request)[levelFor(reply.statusCode, route)](record, 'request completed');
}

// Called from configureApp (main.ts and tests), because hooks can only be added to the
// underlying Fastify instance, not through DI.
export function registerRequestHooks(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance();
  // First thing on every request, so 404s, 429s and validation errors carry the id too.
  fastify.addHook('onRequest', (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
  fastify.addHook('onResponse', (request, reply, done) => {
    logRequestCompleted(request, reply);
    done();
  });
}
