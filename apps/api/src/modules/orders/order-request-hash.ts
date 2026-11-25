import { createHash } from 'node:crypto';
import type { CreateOrderBody } from '@repo/shared';

/**
 * `Order.requestHash`: the same body gives the same hash, so a retry under the same
 * `Idempotency-Key` is recognised as the replay and another body under that key as
 * IDEMPOTENCY_CONFLICT (docs/04, D-49). Built from the fields in a fixed order, never from the
 * parsed object's key order. A field added to the body later must be left OUT of the array while
 * it is absent, so the orders stored before it keep their hash and their retries still replay.
 */
export function orderRequestHash(body: CreateOrderBody): string {
  return createHash('sha256')
    .update(JSON.stringify([body.quoteId]))
    .digest('hex');
}
