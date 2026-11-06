import { CreateQuoteBodySchema } from '@repo/shared';
import { mockQuote } from '../fixtures/orders';
import { fail, ok, type MockRoute } from '../router';

export const quotesRoutes: readonly MockRoute[] = [
  {
    method: 'POST',
    pattern: '/quotes',
    handler: ({ body, now, scenario }) => {
      const parsed = CreateQuoteBodySchema.safeParse(body);
      if (!parsed.success) {
        return fail('VALIDATION_ERROR', {
          fields: parsed.error.issues.map((i) => i.path.join('.')),
        });
      }
      if (scenario === 'priceUnavailable') return fail('PRICE_UNAVAILABLE');
      return ok(mockQuote(now), 201);
    },
  },
];
