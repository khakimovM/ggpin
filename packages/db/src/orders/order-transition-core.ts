// INTERNAL: the unrestricted compare-and-set that every order status change goes through. It is
// not exported from the package index. The public `transitionOrder` (order-transition.ts) wraps it
// with the restrictions of audit H2; `resolveNeedsReview` and the refund helpers call it directly
// for the two edges `transitionOrder` refuses (leaving NEEDS_REVIEW, entering REFUNDED).
// `deliveredAt` is not written here: the SQL guard of `Order` stamps it from the database clock on
// the move to DELIVERED (audit Y11).
import {
  assertTransition,
  type OrderActor,
  type OrderStatus,
  type OrderStatusReason,
} from '@repo/shared';
import { assertInTransaction, type Tx } from '../ledger/ledger.js';
import { ActorRefRequiredError, MissingStatusReasonError, StaleOrderStateError } from './errors.js';

/** The statuses that exist because something went wrong: they must say what. */
export type ReasonedStatus = 'HELD' | 'NEEDS_REVIEW' | 'FAILED';
const REASONED: readonly OrderStatus[] = ['HELD', 'NEEDS_REVIEW', 'FAILED'];

// The order is healthy again: the old reason would be a lie. Every other target keeps the reason
// it has (CANCELLED, REFUNDED), so the cause of a failure survives its refund (review F7).
const CLEARS_REASON: readonly OrderStatus[] = ['QUEUED', 'PROCESSING', 'DELIVERED'];

type ActorPart =
  | { readonly actor: 'system' | 'reconciler'; readonly actorRef?: null }
  /** An operator transition names the operator: the event and the audit row must say who. */
  | { readonly actor: 'admin'; readonly actorRef: string };

type ReasonPart =
  | { readonly to: ReasonedStatus; readonly reason: OrderStatusReason }
  | { readonly to: Exclude<OrderStatus, ReasonedStatus>; readonly reason?: undefined };

export type OrderTransitionInput = {
  readonly orderId: string;
  /** The status the caller read and decided on; the write only happens if it is still current. */
  readonly from: OrderStatus;
  readonly note?: string;
} & ActorPart &
  ReasonPart;

// OrderEvent.actor is free text for the audit trail: SYSTEM | RECONCILER | ADMIN:<id>.
function eventActor(actor: OrderActor, actorRef: string | null | undefined): string {
  if (actor === 'admin') return `ADMIN:${actorRef ?? ''}`;
  return actor === 'reconciler' ? 'RECONCILER' : 'SYSTEM';
}

export async function applyTransition(
  tx: Tx,
  input: OrderTransitionInput,
): Promise<{ readonly eventId: string }> {
  assertInTransaction(tx, 'transitionOrder');
  assertTransition(input.from, input.to, input.actor);
  // Runtime twins of the type-level rules: the inputs also come from job payloads and JS callers.
  if (input.actor === 'admin' && !input.actorRef) throw new ActorRefRequiredError(input.orderId);
  if (REASONED.includes(input.to) && input.reason === undefined) {
    throw new MissingStatusReasonError(input.orderId, input.to);
  }
  const moved = await tx.order.updateMany({
    where: { id: input.orderId, status: input.from },
    data: {
      status: input.to,
      ...(input.reason !== undefined
        ? { statusReason: input.reason }
        : CLEARS_REASON.includes(input.to)
          ? { statusReason: null }
          : {}),
    },
  });
  if (moved.count !== 1) throw new StaleOrderStateError(input.orderId, input.from);
  const event = await tx.orderEvent.create({
    data: {
      orderId: input.orderId,
      from: input.from,
      to: input.to,
      actor: eventActor(input.actor, input.actorRef),
      note: input.note ?? null,
    },
    select: { id: true },
  });
  return { eventId: event.id };
}
