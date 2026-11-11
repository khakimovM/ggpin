// Fastify rejects bodies above this size with FST_ERR_CTP_BODY_TOO_LARGE (mapped to
// 413 PAYLOAD_TOO_LARGE). 1 MiB is ample: the largest legitimate bodies are provider
// callbacks and order requests, a few KiB each.
export const BODY_LIMIT_BYTES = 1_048_576;

export interface RateLimit {
  /** Window length in milliseconds (@nestjs/throttler v6 unit). */
  readonly ttl: number;
  readonly limit: number;
}

// Per client IP. Routes with their own budget (auth 5/min, order create 10/min/user,
// rules/10-backend-nestjs.md) override this with @Throttle() when they are built.
export const DEFAULT_RATE_LIMIT: RateLimit = { ttl: 60_000, limit: 120 };

// Fastify's default (100) answers a longer route parameter with its own 414 before routing:
// outside our envelope, without helmet, CORS, no-store or X-Request-Id. Every path parameter
// is validated by its route instead (a schema -> 400, or the pay view's same 404, docs/04), so
// the router lets anything the HTTP parser accepts through: Node's default maxHeaderSize
// (16 KiB) already caps the request line. No route uses a regex parameter.
export const MAX_PARAM_LENGTH = 16_384;
