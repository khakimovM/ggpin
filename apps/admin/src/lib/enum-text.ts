import {
  ADMIN_ATTEMPT_STATUSES,
  ADMIN_AUDIT_ACTIONS,
  ADMIN_TON_TRANSFER_STATUSES,
  DELIVERY_TYPES,
  INTENT_STATUSES,
  NON_PANEL_AUDIT_ACTIONS,
  ORDER_STATUSES,
  ROUTE_HEALTH_STATES,
} from '@repo/shared';
import { camelKey, type CamelKey } from './camel-key';

// API enums in words (owner 2026-11-23): no screen shows a raw UPPER_SNAKE value. Each group has
// its texts in `admin.enums.<group>.*`; a value the panel does not know yet (a newer API, a free
// text column) gets the one general text `admin.enums.unknown`, never the code itself.

/**
 * Why an order sits in HELD / NEEDS_REVIEW / FAILED. TEMPORARY copy of phase 5's
 * `ORDER_STATUS_REASONS` (`packages/shared/src/orders/order-status-reason.ts`, not on this branch
 * yet): in 9-B, once phase 5 is merged, import that list instead (the column is free text here).
 */
export const ORDER_STATUS_REASONS = [
  'PRICE_ABOVE_MAX',
  'LIMIT_PER_ORDER',
  'LIMIT_DAILY',
  'LOW_BALANCE',
  'NO_ADAPTER',
  'RECIPIENT_CHANGED',
  'RECIPIENT_GONE',
  'ADAPTER_ERROR',
  'CONFIRM_TIMEOUT',
  'HELD_EXPIRED',
] as const;

/** Who moved an order (`events[].actor`: SYSTEM, RECONCILER, ADMIN or ADMIN:<id>, ...). */
export const ORDER_EVENT_ACTORS = ['SYSTEM', 'RECONCILER', 'ADMIN', 'USER', 'WORKER'] as const;

export const ENUM_GROUPS = {
  orderStatus: ORDER_STATUSES,
  intentStatus: INTENT_STATUSES,
  orderReason: ORDER_STATUS_REASONS,
  auditAction: [...ADMIN_AUDIT_ACTIONS, ...NON_PANEL_AUDIT_ACTIONS],
  deliveryType: DELIVERY_TYPES,
  routeHealth: ROUTE_HEALTH_STATES,
  attemptStatus: ADMIN_ATTEMPT_STATUSES,
  tonStatus: ADMIN_TON_TRANSFER_STATUSES,
  eventActor: ORDER_EVENT_ACTORS,
} as const;

export type EnumGroup = keyof typeof ENUM_GROUPS;
type ValueOf<G extends EnumGroup> = (typeof ENUM_GROUPS)[G][number];

export type EnumTextKey<G extends EnumGroup> =
  `admin.enums.${G}.${CamelKey<ValueOf<G>>}` | 'admin.enums.unknown';

/** The general text of a value the panel does not know. */
export const UNKNOWN_ENUM_KEY = 'admin.enums.unknown';

/** The i18n key of `value` in `group`; the general "unknown" text for anything else. */
export function enumKey<G extends EnumGroup>(group: G, value: string): EnumTextKey<G> {
  const known: readonly string[] = ENUM_GROUPS[group];
  if (!known.includes(value)) return UNKNOWN_ENUM_KEY;
  return `admin.enums.${group}.${camelKey(value)}` as EnumTextKey<G>;
}

/** An event's actor: `ADMIN:<id>` is an admin; lower-case spellings count as the same name. */
export function eventActorKey(actor: string): EnumTextKey<'eventActor'> {
  const name = actor.split(':')[0] ?? '';
  return enumKey('eventActor', name.toUpperCase());
}
