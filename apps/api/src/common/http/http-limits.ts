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
