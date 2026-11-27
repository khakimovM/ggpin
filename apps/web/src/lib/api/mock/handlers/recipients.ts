import { ValidateRecipientBodySchema } from '@repo/shared';
import { MOCK_RECIPIENT, MOCK_RECIPIENT_PREMIUM_EXTENDS } from '../fixtures/orders';
import { fail, ok, type MockRoute } from '../router';

/** Seconds the busy scenario asks to wait, short enough to watch the countdown end in dev. */
export const RECIPIENT_BUSY_RETRY_SEC = 5;

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
      // docs/04: this user's previous check is still running (or 20 a minute were asked).
      if (scenario === 'recipientBusy') {
        return { ...fail('RATE_LIMITED'), retryAfter: String(RECIPIENT_BUSY_RETRY_SEC) };
      }
      return ok(MOCK_RECIPIENT);
    },
  },
];
