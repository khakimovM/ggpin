import { ORDER_STATUSES, type OrderDetail, type OrderStatus } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  ORDER_POLL_MS,
  ORDER_REVIEW_POLL_MS,
  chipKeyOf,
  heroKindOf,
  isActiveOrder,
  isRefundedOrder,
  orderPollInterval,
} from '../order-status';
import { buildSteps } from '../order-timeline';

describe('the nine statuses', () => {
  const table: Array<[OrderStatus, string, string, boolean]> = [
    // status, chip label key, hero, polled
    ['PAID', 'queued', 'paid', true],
    ['QUEUED', 'queued', 'queued', true],
    ['PROCESSING', 'processing', 'processing', true],
    ['HELD', 'review', 'review', true],
    ['NEEDS_REVIEW', 'review', 'review', true],
    ['DELIVERED', 'delivered', 'delivered', false],
    ['FAILED', 'refunded', 'failed', false],
    ['REFUNDED', 'refunded', 'refunded', false],
    ['CANCELLED', 'cancelled', 'cancelled', false],
  ];

  it('covers every status the server can send', () => {
    expect(table.map(([status]) => status).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it.each(table)('%s -> chip %s, hero %s, polling %s', (status, chip, hero, polled) => {
    expect(chipKeyOf(status)).toBe(chip);
    expect(heroKindOf(status, false)).toBe(hero);
    expect(isActiveOrder(status)).toBe(polled);
    const waitsForAPerson = status === 'HELD' || status === 'NEEDS_REVIEW';
    expect(orderPollInterval(status)).toBe(
      !polled ? false : waitsForAPerson ? ORDER_REVIEW_POLL_MS : ORDER_POLL_MS,
    );
  });

  it('a delivered order with a code is "Kod tayyor!", every other one ignores the code', () => {
    expect(heroKindOf('DELIVERED', true)).toBe('voucher');
    expect(heroKindOf('PROCESSING', true)).toBe('processing');
  });

  it("does not poll before the first answer (a failed first load is the visitor's retry)", () => {
    expect(orderPollInterval(undefined)).toBe(false);
  });

  it('a held order is asked about slowly: it waits for a person, not for the next second', () => {
    expect(ORDER_REVIEW_POLL_MS).toBeGreaterThanOrEqual(15_000);
    expect(ORDER_REVIEW_POLL_MS).toBeLessThanOrEqual(30_000);
    expect(orderPollInterval('HELD')).toBe(ORDER_REVIEW_POLL_MS);
    expect(orderPollInterval('NEEDS_REVIEW')).toBe(ORDER_REVIEW_POLL_MS);
    expect(orderPollInterval('PROCESSING')).toBe(ORDER_POLL_MS);
  });

  it('failed and cancelled orders show the full amount coming back; a REFUNDED one shows no figure', () => {
    // an admin may have refunded only part of it, and the DTO has no refunded amount yet
    for (const status of ORDER_STATUSES) {
      expect(isRefundedOrder(status)).toBe(['FAILED', 'CANCELLED'].includes(status));
    }
  });
});

function detail(status: OrderStatus, steps: Array<[OrderStatus, string]>): OrderDetail {
  return {
    id: 'o1',
    number: 7,
    status,
    productId: 'p1',
    productSlug: 'telegram-stars',
    productName: 'Telegram Stars',
    skuId: null,
    quantity: 50,
    recipient: { displayName: 'Aziz', fields: { username: 'aziz_k' } },
    priceTiyin: '550000',
    discountTiyin: '0',
    totalTiyin: '550000',
    currency: 'UZS',
    createdAt: '2026-11-08T10:00:00.000Z',
    deliveredAt: null,
    timeline: steps.map(([s, at]) => ({ status: s, at })),
    voucher: null,
  };
}
const at = (minute: number) => `2026-11-08T10:0${minute}:00.000Z`;
const view = (order: OrderDetail) =>
  buildSteps(order).map((s) => `${s.id}:${s.state}${s.tone ? `:${s.tone}` : ''}`);

describe('the steps of the page', () => {
  it('in progress: the reached steps are done, the current one is active, the rest wait', () => {
    expect(view(detail('PAID', [['PAID', at(0)]]))).toEqual([
      'paid:active',
      'queued:pending',
      'processing:pending',
      'delivered:pending',
    ]);
    expect(
      view(
        detail('PROCESSING', [
          ['PAID', at(0)],
          ['QUEUED', at(1)],
          ['PROCESSING', at(2)],
        ]),
      ),
    ).toEqual(['paid:done', 'queued:done', 'processing:active', 'delivered:pending']);
  });

  it('delivered: everything is done, with the recorded times and none invented', () => {
    const steps = buildSteps(
      detail('DELIVERED', [
        ['PAID', at(0)],
        ['QUEUED', at(1)],
        ['PROCESSING', at(2)],
        ['DELIVERED', at(3)],
      ]),
    );
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(steps.map((s) => s.at)).toEqual([at(0), at(1), at(2), at(3)]);
    // a step that has not happened has no time
    expect(
      buildSteps(
        detail('QUEUED', [
          ['PAID', at(0)],
          ['QUEUED', at(1)],
        ]),
      )[3]?.at,
    ).toBeNull();
  });

  it('under review: the third step is "being checked" and warns', () => {
    expect(
      view(
        detail('NEEDS_REVIEW', [
          ['PAID', at(0)],
          ['QUEUED', at(1)],
          ['NEEDS_REVIEW', at(2)],
        ]),
      ),
    ).toEqual(['paid:done', 'queued:done', 'review:active:warning', 'delivered:pending']);
    expect(
      view(
        detail('HELD', [
          ['PAID', at(0)],
          ['HELD', at(1)],
        ]),
      )[2],
    ).toBe('review:active:warning');
  });

  it('failed and refunded: the steps that happened, the failure, the money back', () => {
    expect(
      view(
        detail('REFUNDED', [
          ['PAID', at(0)],
          ['QUEUED', at(1)],
          ['PROCESSING', at(2)],
          ['FAILED', at(3)],
          ['REFUNDED', at(4)],
        ]),
      ),
    ).toEqual([
      'paid:done',
      'queued:done',
      'processing:done',
      'failed:done:danger',
      'refunded:done:refund',
    ]);
    // a failure before any work started shows no processing step
    expect(
      view(
        detail('REFUNDED', [
          ['PAID', at(0)],
          ['FAILED', at(1)],
          ['REFUNDED', at(2)],
        ]),
      ),
    ).toEqual(['paid:done', 'failed:done:danger', 'refunded:done:refund']);
  });

  it('the refund step carries only the time the server recorded for it', () => {
    const refundTime = (order: OrderDetail) =>
      buildSteps(order).find((step) => step.id === 'refunded')?.at;
    expect(
      refundTime(
        detail('FAILED', [
          ['PAID', at(0)],
          ['FAILED', at(3)],
        ]),
      ),
    ).toBeNull();
    expect(
      refundTime(
        detail('CANCELLED', [
          ['PAID', at(0)],
          ['CANCELLED', at(2)],
        ]),
      ),
    ).toBeNull();
    expect(
      refundTime(
        detail('REFUNDED', [
          ['PAID', at(0)],
          ['FAILED', at(3)],
          ['REFUNDED', at(4)],
        ]),
      ),
    ).toBe(at(4));
  });

  it('cancelled: paid, cancelled, refunded', () => {
    expect(
      view(
        detail('CANCELLED', [
          ['PAID', at(0)],
          ['CANCELLED', at(1)],
        ]),
      ),
    ).toEqual(['paid:done', 'cancelled:done:muted', 'refunded:done:refund']);
  });
});
