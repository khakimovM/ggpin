import { headers } from 'next/headers';
import { NONCE_HEADER, NONCE_PATTERN } from './nonce';

/**
 * The nonce the middleware generated for this request. Reading request headers also makes the
 * route dynamic, which is the point: a statically prerendered page has no per-request nonce, so
 * its inline scripts (Next's own RSC payload included) would be blocked by the CSP.
 *
 * Returns undefined when the middleware did not run for this request (its matcher skips `/api*`,
 * `_next` and static-extension paths, none of which render these layouts), or when the header has
 * an unexpected shape: it is dropped rather than echoed into the HTML. A page rendered without a
 * nonce then has none on its scripts, and the browser blocks them: it fails closed.
 */
export async function requestNonce(): Promise<string | undefined> {
  const value = (await headers()).get(NONCE_HEADER);
  return value !== null && NONCE_PATTERN.test(value) ? value : undefined;
}
