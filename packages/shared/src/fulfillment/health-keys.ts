// Redis keys through which the worker reports adapter health and the API/router reads it. One
// builder in one place: a typo would make a dead Fragment session look healthy (or the reverse).
import { z } from 'zod';

/**
 * Fragment session health: `ok` while the keep-alive sees a logged-in page, `down` once the
 * session is DEAD. The API readiness probe maps a missing key to `disabled` (docs/04 health),
 * so only these two values are ever written.
 */
export const FRAGMENT_HEALTH_KEY = 'fragment:health';
export const FRAGMENT_HEALTH_VALUES = ['ok', 'down'] as const;
export type FragmentHealthValue = (typeof FRAGMENT_HEALTH_VALUES)[number];

/** `FulfillmentAdapter.health()` (docs/06): what the router reads to pick a route. */
export const ADAPTER_HEALTH_VALUES = ['OK', 'DEGRADED', 'DOWN'] as const;
export type AdapterHealth = (typeof ADAPTER_HEALTH_VALUES)[number];

/** Adapter codes are `ProductRoute.adapter` values: FRAGMENT, RESELLER_STARS, FAZERCARDS... */
const AdapterCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/);

/** `adapter:health:<code>`. Throws on a code that could escape the key namespace. */
export function adapterHealthKey(adapterCode: string): string {
  return `adapter:health:${AdapterCodeSchema.parse(adapterCode)}`;
}
