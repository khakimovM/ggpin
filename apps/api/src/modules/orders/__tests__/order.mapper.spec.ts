import { Logger } from '@nestjs/common';
import { OrderDetailSchema, OrderSchema, RECIPIENT_PLACEHOLDER } from '@repo/shared';
import {
  orderTimeline,
  toOrderDetail,
  toOrderDto,
  type TimelineEvent,
} from '../entities/order.mapper';
import { NOW, detailRow, orderRow } from './orders.fixtures';

const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);
const event = (
  from: TimelineEvent['from'],
  to: TimelineEvent['to'],
  seconds: number,
): TimelineEvent => ({ from, to, createdAt: at(seconds) });

describe('toOrderDto', () => {
  it('is exactly the docs/04 order shape', () => {
    const dto = toOrderDto(orderRow(), 'uz');
    expect(OrderSchema.parse(dto)).toEqual(dto);
    expect(dto).toEqual({
      id: 'o1',
      number: 1042,
      status: 'PAID',
      productId: 'p1',
      productSlug: 'telegram-stars',
      productName: 'Telegram Stars uz',
      skuId: 's50',
      quantity: 50,
      recipient: { displayName: 'Aziz', fields: { username: 'aziz_k' } },
      priceTiyin: '550000',
      discountTiyin: '0',
      totalTiyin: '550000',
      currency: 'UZS',
      createdAt: NOW.toISOString(),
      deliveredAt: null,
    });
  });

  it('names the product in the asked language and keeps a custom quantity’s null skuId', () => {
    const dto = toOrderDto(orderRow({ skuId: null, quantity: 75 }), 'ru');
    expect([dto.productName, dto.skuId, dto.quantity]).toEqual(['Telegram Stars ru', null, 75]);
  });

  it('total = price - discount, as decimal strings beyond 2^53', () => {
    const dto = toOrderDto(
      orderRow({ priceTiyin: 9_007_199_254_740_993n, discountTiyin: 2n }),
      'uz',
    );
    expect([dto.priceTiyin, dto.discountTiyin, dto.totalTiyin]).toEqual([
      '9007199254740993',
      '2',
      '9007199254740991',
    ]);
  });

  it('drops the recipient photo and anything internal the row might carry', () => {
    const leaky = {
      ...orderRow({ deliveredAt: at(70) }),
      recipient: { username: 'aziz_k', displayName: 'Aziz', photoUrl: 'https://x.test/a.png' },
      providerRef: 'ref_777',
      costMinor: 125_000_000n,
      maxCostMinor: 128_750_000n,
      fxRateId: 'fx_1',
      requestHash: 'h',
    };
    const dto = toOrderDto(leaky, 'uz');
    expect(dto.recipient).toEqual({ displayName: 'Aziz', fields: { username: 'aziz_k' } });
    expect(dto.deliveredAt).toBe(at(70).toISOString());
    expect(JSON.stringify(dto)).not.toMatch(/ref_777|125000000|128750000|fx_1|photo|requestHash/);
  });

  // Review M2 / audit I6: a stored row is read leniently, so one row of an older input rule can
  // never turn the list, the order or a replay into a 500.
  it('a row of an older rule (a username today’s pattern refuses, unknown keys) is still shown', () => {
    const old = orderRow({ recipient: { username: 'old-name.1', displayName: 'Eski', v: 1 } });
    const dto = toOrderDto(old, 'uz');
    expect(OrderSchema.parse(dto)).toEqual(dto);
    expect(dto.recipient).toEqual({ displayName: 'Eski', fields: { username: 'old-name.1' } });
  });

  it.each([
    ['another product’s shape', { playerId: '5551234' }],
    ['not an object', '5551234'],
    ['null', null],
  ])(
    'a recipient with neither name nor username (%s): a placeholder and a warning, no throw',
    (_case, recipient) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const dto = toOrderDto(orderRow({ recipient }), 'uz');
      expect(OrderSchema.parse(dto)).toEqual(dto);
      expect(dto.recipient).toEqual({ displayName: RECIPIENT_PLACEHOLDER, fields: {} });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('order o1'));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('5551234');
      warn.mockRestore();
    },
  );
});

describe('orderTimeline', () => {
  it('oldest first, one item per status entered', () => {
    const events = [
      event('QUEUED', 'PROCESSING', 5),
      event(null, 'PAID', 0),
      event('PROCESSING', 'DELIVERED', 70),
      event('PAID', 'QUEUED', 1),
    ];
    expect(orderTimeline(events)).toEqual([
      { status: 'PAID', at: at(0).toISOString() },
      { status: 'QUEUED', at: at(1).toISOString() },
      { status: 'PROCESSING', at: at(5).toISOString() },
      { status: 'DELIVERED', at: at(70).toISOString() },
    ]);
  });

  it('events of one transaction (same instant) follow the chain: FAILED before REFUNDED', () => {
    const events = [
      event('FAILED', 'REFUNDED', 9),
      event('PROCESSING', 'FAILED', 9),
      event(null, 'PAID', 0),
      event('PAID', 'QUEUED', 1),
      event('QUEUED', 'PROCESSING', 2),
    ];
    expect(orderTimeline(events).map((item) => item.status)).toEqual([
      'PAID',
      'QUEUED',
      'PROCESSING',
      'FAILED',
      'REFUNDED',
    ]);
  });

  it('a status entered twice (HELD and back) keeps both visits in time order', () => {
    const events = [
      event('QUEUED', 'PROCESSING', 7),
      event('HELD', 'QUEUED', 6),
      event('PROCESSING', 'HELD', 3),
      event('QUEUED', 'PROCESSING', 2),
      event('PAID', 'QUEUED', 1),
      event(null, 'PAID', 0),
    ];
    expect(orderTimeline(events).map((item) => item.status)).toEqual([
      'PAID',
      'QUEUED',
      'PROCESSING',
      'HELD',
      'QUEUED',
      'PROCESSING',
    ]);
  });

  it('a broken chain still lists every event, earliest first where the chain gives no answer', () => {
    const events = [event('PAID', 'QUEUED', 1), event('QUEUED', 'PROCESSING', 2)];
    expect(orderTimeline(events).map((item) => item.status)).toEqual(['QUEUED', 'PROCESSING']);
  });
});

describe('toOrderDetail', () => {
  it('the list shape + timeline + voucher null (Stars and Premium carry none)', () => {
    const row = detailRow({
      status: 'QUEUED',
      events: [event('PAID', 'QUEUED', 1), event(null, 'PAID', 0)],
    });
    const detail = toOrderDetail(row, 'ru');
    expect(OrderDetailSchema.parse(detail)).toEqual(detail);
    expect(detail.timeline.map((item) => item.status)).toEqual(['PAID', 'QUEUED']);
    expect([detail.voucher, detail.productName]).toEqual([null, 'Telegram Stars ru']);
  });
});
