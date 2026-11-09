import { CLIENT_STATUS_GROUP, ORDER_STATUSES } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { ORDER_FILTERS, statusesOf } from '../order-filters';

describe('statusesOf', () => {
  it('sends no filter for "all"', () => {
    expect(statusesOf('all')).toBeUndefined();
  });

  it('maps the chips onto the client label groups of docs/04', () => {
    expect(statusesOf('done')).toEqual(['DELIVERED']);
    expect(statusesOf('wait')).toEqual(['PAID', 'QUEUED', 'PROCESSING', 'HELD', 'NEEDS_REVIEW']);
    expect([...(statusesOf('cancel') ?? [])].sort()).toEqual(['CANCELLED', 'FAILED', 'REFUNDED']);
  });

  it('puts every status in exactly one chip, so no order is lost between the filters', () => {
    const chips = ORDER_FILTERS.filter((filter) => filter !== 'all');
    for (const status of ORDER_STATUSES) {
      const holding = chips.filter((filter) => statusesOf(filter)?.includes(status));
      expect(holding, `${status} (${CLIENT_STATUS_GROUP[status]})`).toHaveLength(1);
    }
  });
});
