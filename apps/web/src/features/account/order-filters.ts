import {
  CLIENT_STATUS_GROUP,
  ORDER_STATUSES,
  type ClientStatusGroup,
  type OrderStatus,
} from '@repo/shared';

// The filter chips of the order history (Account.dc.html `filter`). A chip is a group of raw
// statuses, sent as ONE request (`status=PAID,QUEUED,...`, docs/04 Q-C): the label groups are the
// ones of CLIENT_STATUS_GROUP, so a chip and the status chip on a row never disagree.

export const ORDER_FILTERS = ['all', 'done', 'wait', 'cancel'] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number];

const inGroups = (...groups: ClientStatusGroup[]): OrderStatus[] =>
  ORDER_STATUSES.filter((status) => groups.includes(CLIENT_STATUS_GROUP[status]));

const FILTER_STATUSES: Record<OrderFilter, readonly OrderStatus[] | undefined> = {
  all: undefined,
  done: inGroups('DELIVERED'),
  wait: inGroups('QUEUED', 'PROCESSING', 'REVIEW'),
  cancel: inGroups('REFUNDED', 'CANCELLED'),
};

/** The `status` of `GET /orders` for a chip; undefined for "all" (no filter). */
export function statusesOf(filter: OrderFilter): readonly OrderStatus[] | undefined {
  return FILTER_STATUSES[filter];
}
