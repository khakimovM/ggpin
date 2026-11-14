import { OrderDetailSchema, OrderSchema } from '@repo/shared';
import { WithMeta } from '../../../common/http/with-meta';
import { detailRow, failure, orderRow, setup } from './orders.fixtures';

describe('OrdersService.list', () => {
  it('reads the session user’s page with the filter and maps every row in the asked language', async () => {
    const { service, repository } = setup();
    repository.listOwn.mockResolvedValueOnce({
      rows: [orderRow({ id: 'o2', number: 2 }), orderRow({ id: 'o1', number: 1 })],
      total: 7,
    });
    const query = {
      status: ['PAID' as const, 'QUEUED' as const],
      locale: 'ru' as const,
      page: 2,
      limit: 2,
    };
    const out = await service.list('user-A', query);
    expect(repository.listOwn).toHaveBeenCalledWith('user-A', query);
    expect(out).toBeInstanceOf(WithMeta);
    expect(out.meta).toEqual({ page: 2, limit: 2, total: 7 });
    expect(out.data.map((order) => [order.id, order.productName])).toEqual([
      ['o2', 'Telegram Stars ru'],
      ['o1', 'Telegram Stars ru'],
    ]);
    for (const order of out.data) expect(OrderSchema.parse(order)).toEqual(order);
  });
});

describe('OrdersService.get', () => {
  it('another user’s or a missing order: 404, looked up by the session user only', async () => {
    const { service, repository } = setup();
    repository.findOwnDetail.mockResolvedValueOnce(null);
    expect((await failure(service.get('user-A', 'o1', { locale: 'uz' }))).code).toBe('NOT_FOUND');
    expect(repository.findOwnDetail).toHaveBeenCalledWith('user-A', 'o1');
  });

  it('the detail: list shape + timeline + voucher null, in the asked language', async () => {
    const { service } = setup();
    const out = await service.get('u1', 'o1', { locale: 'uz' });
    expect(OrderDetailSchema.parse(out)).toEqual(out);
    expect(out).toMatchObject({
      id: 'o1',
      productName: 'Telegram Stars uz',
      timeline: [{ status: 'PAID', at: detailRow().createdAt.toISOString() }],
      voucher: null,
    });
  });
});
