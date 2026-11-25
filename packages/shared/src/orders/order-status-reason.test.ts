import { describe, expect, it } from 'vitest';
import { ORDER_STATUS_REASONS, orderStatusReasonSchema } from './order-status-reason';
import { OrderSchema } from './order-schemas';

describe('order status reasons', () => {
  it('are exactly the plan list, in a closed set', () => {
    expect([...ORDER_STATUS_REASONS]).toEqual([
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
    ]);
  });

  it('the schema accepts each reason and nothing else', () => {
    for (const reason of ORDER_STATUS_REASONS) {
      expect(orderStatusReasonSchema.safeParse(reason).success).toBe(true);
    }
    for (const bad of ['', 'price_above_max', 'SOMETHING', null, undefined]) {
      expect(orderStatusReasonSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('is internal: the order the customer sees has no reason field', () => {
    expect(Object.keys(OrderSchema.shape)).not.toContain('statusReason');
  });
});
