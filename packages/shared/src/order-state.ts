// The ONLY source of allowed Order.status transitions (.claude/rules/45-fulfillment.md).
// Table = docs/06-FULFILLMENT.md "Holatlar oqimi" + D-23 (DELIVERED→REFUNDED, HELD→CANCELLED).
import { z } from 'zod';

// There is deliberately no QUOTED state: a Quote is its own model (03-DATA-MODEL) and an Order
// is only created, already PAID, inside the purchase transaction.
export const ORDER_STATUSES = [
  'PAID',
  'QUEUED',
  'PROCESSING',
  'HELD',
  'NEEDS_REVIEW',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
] as const;

export const orderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/** `system` = API/worker/reconcile code paths; `admin` = a human operator (audited). */
export const ORDER_ACTORS = ['system', 'admin'] as const;
export type OrderActor = (typeof ORDER_ACTORS)[number];

const SYSTEM: readonly OrderActor[] = ['system'];
const ADMIN: readonly OrderActor[] = ['admin'];
const ANY: readonly OrderActor[] = ['system', 'admin'];

type TransitionTable = Record<OrderStatus, Partial<Record<OrderStatus, readonly OrderActor[]>>>;

// Why each actor list:
// - cancellations and DELIVERED→REFUNDED move or return money by human decision → admin only;
// - NEEDS_REVIEW resolves via the reconciler (system) or an operator (admin);
// - HELD is released by the worker when price/limits recover, or by an operator;
// - the refund legs (FAILED/CANCELLED→REFUNDED) are written by the refund transaction itself,
//   which runs as system after a failure and as admin after an admin cancellation.
export const ORDER_TRANSITIONS: TransitionTable = {
  PAID: { QUEUED: SYSTEM, CANCELLED: ADMIN },
  QUEUED: { PROCESSING: SYSTEM, CANCELLED: ADMIN },
  PROCESSING: { DELIVERED: SYSTEM, FAILED: SYSTEM, HELD: SYSTEM, NEEDS_REVIEW: SYSTEM },
  HELD: { QUEUED: ANY, FAILED: ANY, CANCELLED: ADMIN },
  NEEDS_REVIEW: { DELIVERED: ANY, FAILED: ANY },
  DELIVERED: { REFUNDED: ADMIN },
  FAILED: { REFUNDED: ANY },
  CANCELLED: { REFUNDED: ANY },
  REFUNDED: {},
};

export type IllegalTransitionReason = 'NO_SUCH_TRANSITION' | 'ACTOR_NOT_ALLOWED';

export class IllegalOrderTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    readonly actor: OrderActor,
    readonly reason: IllegalTransitionReason,
  ) {
    super(`Illegal order transition ${from} -> ${to} by ${actor} (${reason})`);
    this.name = 'IllegalOrderTransitionError';
  }
}

function allowedActors(from: OrderStatus, to: OrderStatus): readonly OrderActor[] | undefined {
  return ORDER_TRANSITIONS[from][to];
}

export function canTransition(from: OrderStatus, to: OrderStatus, actor: OrderActor): boolean {
  return allowedActors(from, to)?.includes(actor) ?? false;
}

/** Throws IllegalOrderTransitionError unless `actor` may move an order from → to. */
export function assertTransition(from: OrderStatus, to: OrderStatus, actor: OrderActor): void {
  const actors = allowedActors(from, to);
  if (!actors) throw new IllegalOrderTransitionError(from, to, actor, 'NO_SUCH_TRANSITION');
  if (!actors.includes(actor)) {
    throw new IllegalOrderTransitionError(from, to, actor, 'ACTOR_NOT_ALLOWED');
  }
}

/** Statuses `actor` may move an order to next. */
export function nextStatuses(from: OrderStatus, actor: OrderActor): OrderStatus[] {
  return ORDER_STATUSES.filter((to) => canTransition(from, to, actor));
}

/**
 * No outgoing edge for anyone. Only REFUNDED: DELIVERED and CANCELLED still have a refund edge,
 * so UI polling must not use this to decide when to stop (see CLIENT_STATUS_GROUP).
 */
export function isTerminalStatus(status: OrderStatus): boolean {
  return Object.keys(ORDER_TRANSITIONS[status]).length === 0;
}

/** Client-facing grouping from docs/04-API-CONTRACT.md; the label text lives in i18n. */
export const CLIENT_STATUS_GROUPS = [
  'QUEUED',
  'PROCESSING',
  'REVIEW',
  'DELIVERED',
  'REFUNDED',
  'CANCELLED',
] as const;
export type ClientStatusGroup = (typeof CLIENT_STATUS_GROUPS)[number];

export const CLIENT_STATUS_GROUP: Record<OrderStatus, ClientStatusGroup> = {
  PAID: 'QUEUED',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  HELD: 'REVIEW',
  NEEDS_REVIEW: 'REVIEW',
  DELIVERED: 'DELIVERED',
  FAILED: 'REFUNDED',
  REFUNDED: 'REFUNDED',
  CANCELLED: 'CANCELLED',
};
