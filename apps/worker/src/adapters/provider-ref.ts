import { RecipientProviderRefSchema } from '@repo/shared';
import type { AdapterCode } from './fulfillment-adapter';

// Which adapter a recipient handle came from (phase 5 S7, S3b review CR #2, D-62 candidate). The
// handle an adapter's `validateRecipient` returns means something to THAT provider only (a
// Fragment recipient id is not a reseller's user id). The worker's lookup stores it namespaced,
// `<ADAPTER_CODE>:<adapter's own handle>`, so the token, the Quote and the Order (all opaque
// strings, no schema change) say who issued it, and fulfillment can tell whether the adapter it
// picked may compare the handle or must check the recipient again.

/** `ProductRoute.adapter` codes (health-keys.ts uses the same shape). */
const ADAPTER_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;
const SEPARATOR = ':';

export interface ParsedProviderRef {
  readonly adapter: AdapterCode;
  /** The adapter's own handle, what its `prepare` compares. */
  readonly ref: string;
}

/**
 * The stored form of an adapter's handle. Throws (a ZodError or a RangeError) when the code is
 * not an adapter code or the result does not fit the shared handle schema (256 characters): the
 * lookup then answers UNAVAILABLE (BAD_ANSWER), never a handle nobody can read back.
 */
export function namespacedProviderRef(adapter: AdapterCode, ref: string): string {
  if (!ADAPTER_CODE.test(adapter)) throw new RangeError('not an adapter code');
  RecipientProviderRefSchema.parse(ref);
  return RecipientProviderRefSchema.parse(`${adapter}${SEPARATOR}${ref}`);
}

/**
 * The issuer and the adapter's own handle of a stored handle, or null for a handle without a
 * namespace (written before S7: such a handle is handed to the adapter unchanged, as before).
 */
export function parseProviderRef(stored: string): ParsedProviderRef | null {
  const at = stored.indexOf(SEPARATOR);
  if (at <= 0) return null;
  const adapter = stored.slice(0, at);
  const ref = stored.slice(at + 1);
  if (!ADAPTER_CODE.test(adapter) || ref.trim() === '') return null;
  return { adapter, ref };
}
