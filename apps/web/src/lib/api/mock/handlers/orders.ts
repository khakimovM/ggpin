import { CreateOrderBodySchema, OrderListQuerySchema } from '@repo/shared';
import { mockOrder, mockOrderDetail, mockOrderList, mockQuote } from '../fixtures/orders';
import { fail, ok, page, type MockRoute } from '../router';

export const ordersRoutes: readonly MockRoute[] = [
  {
    method: 'POST',
    pattern: '/orders',
    handler: ({ body, headers, now, scenario }) => {
      if (headers['idempotency-key'] === undefined) return fail('VALIDATION_ERROR');
      const parsed = CreateOrderBodySchema.safeParse(body);
      if (!parsed.success) {
        return fail('VALIDATION_ERROR', {
          fields: parsed.error.issues.map((i) => i.path.join('.')),
        });
      }
      if (scenario === 'insufficient') {
        // The server computes these; the mock only has to look like it.
        return fail('INSUFFICIENT_BALANCE', {
          balance: '1000000',
          required: mockQuote(now).totalTiyin,
          shortfall: '7540000',
        });
      }
      return ok({ order: mockOrder('PAID', now) }, 201);
    },
  },
  {
    method: 'GET',
    pattern: '/orders',
    handler: ({ query, now, locale }) => {
      const parsed = OrderListQuerySchema.safeParse({
        locale,
        ...Object.fromEntries(query),
      });
      if (!parsed.success) {
        return fail('VALIDATION_ERROR', {
          fields: parsed.error.issues.map((i) => i.path.join('.')),
        });
      }
      const { status } = parsed.data;
      return page(
        mockOrderList(now).filter((order) => status === undefined || status.includes(order.status)),
        query,
      );
    },
  },
  {
    method: 'GET',
    pattern: '/orders/:id',
    handler: ({ params, now, scenario }) =>
      ok(mockOrderDetail(scenario === 'orderFailed' ? 'FAILED' : 'PROCESSING', now, params.id)),
  },
];
