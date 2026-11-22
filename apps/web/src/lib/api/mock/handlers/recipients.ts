import { ValidateRecipientBodySchema } from '@repo/shared';
import { MOCK_RECIPIENT, MOCK_RECIPIENT_PREMIUM_EXTENDS } from '../fixtures/orders';
import { fail, ok, type MockRoute } from '../router';

export const recipientsRoutes: readonly MockRoute[] = [
  {
    method: 'POST',
    pattern: '/recipients/validate',
    handler: ({ body, scenario }) => {
      const parsed = ValidateRecipientBodySchema.safeParse(body);
      if (!parsed.success) {
        return fail('VALIDATION_ERROR', {
          fields: parsed.error.issues.map((i) => i.path.join('.')),
        });
      }
      if (scenario === 'recipientNotFound') return fail('RECIPIENT_NOT_FOUND');
      if (scenario === 'hasPremiumExtends') return ok(MOCK_RECIPIENT_PREMIUM_EXTENDS);
      return ok(MOCK_RECIPIENT);
    },
  },
];
