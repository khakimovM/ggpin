const DEFAULT_RETRY_SEC = 5;
const MAX_RETRY_SEC = 60;

/** How long to wait after a 429: the server's `Retry-After` if it sent one, clamped to 1..60 s. */
export function retryDelaySec(retryAfterSec: number | undefined): number {
  const wanted = retryAfterSec ?? DEFAULT_RETRY_SEC;
  return Math.min(MAX_RETRY_SEC, Math.max(1, Math.ceil(wanted)));
}
