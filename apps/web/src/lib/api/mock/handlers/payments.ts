import {
  CreateTopupIntentBodySchema,
  TOPUP_DEFAULTS,
  PAY_TOKEN_HEADER,
  buildPayLink,
} from '@repo/shared';
import {
  MOCK_PAYMENT_METHODS,
  MOCK_PAY_TOKEN,
  mockIntent,
  mockIntentCreated,
  mockPayView,
} from '../fixtures/payments';
import { fail, ok, type MockRoute } from '../router';

// Mirrors the server's range check so the top-up form can be exercised against its 422.
function amountInRange(amountTiyin: string): boolean {
  const amount = BigInt(amountTiyin);
  return (
    amount >= TOPUP_DEFAULTS.MIN_TIYIN &&
    amount <= TOPUP_DEFAULTS.MAX_TIYIN &&
    amount % TOPUP_DEFAULTS.STEP_TIYIN === 0n
  );
}

export const paymentsRoutes: readonly MockRoute[] = [
  { method: 'GET', pattern: '/payments/methods', handler: () => ok(MOCK_PAYMENT_METHODS) },
  {
    method: 'POST',
    pattern: '/payments/intents',
    handler: ({ body, headers, now, siteUrl, locale }) => {
      if (headers['idempotency-key'] === undefined) return fail('VALIDATION_ERROR');
      const parsed = CreateTopupIntentBodySchema.safeParse(body);
      if (!parsed.success) {
        return fail('VALIDATION_ERROR', {
          fields: parsed.error.issues.map((i) => i.path.join('.')),
        });
      }
      if (!amountInRange(parsed.data.amountTiyin)) {
        return fail('TOPUP_AMOUNT_OUT_OF_RANGE', {
          min: TOPUP_DEFAULTS.MIN_TIYIN.toString(),
          max: TOPUP_DEFAULTS.MAX_TIYIN.toString(),
          step: TOPUP_DEFAULTS.STEP_TIYIN.toString(),
        });
      }
      // The mock adds a fixed unique extra; the real server picks a free one.
      const payTiyin = (BigInt(parsed.data.amountTiyin) + 37_700n).toString();
      return ok(
        mockIntentCreated({
          siteUrl,
          now,
          locale,
          baseTiyin: parsed.data.amountTiyin,
          payTiyin,
        }),
        201,
      );
    },
  },
  {
    method: 'GET',
    pattern: '/payments/intents',
    // A plain array, as docs/04 specifies: no `meta`. `status` and `limit` are honoured.
    handler: ({ query, now, scenario }) => {
      const intents = [mockIntent(scenario === 'intentExpired' ? 'EXPIRED' : 'PENDING', now)];
      const status = query.get('status');
      const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 20));
      return ok(
        intents.filter((intent) => status === null || intent.status === status).slice(0, limit),
      );
    },
  },
  {
    method: 'GET',
    pattern: '/payments/intents/:id',
    handler: ({ params, now, scenario }) =>
      ok(mockIntent(scenario === 'intentExpired' ? 'EXPIRED' : 'PENDING', now, params.id)),
  },
  {
    method: 'POST',
    pattern: '/payments/intents/:id/cancel',
    handler: ({ params }) => ok({ intentId: params.id, status: 'CANCELLED' }),
  },
  {
    method: 'POST',
    pattern: '/payments/intents/:id/pay-link',
    // The language is the user's own (the real API reads it from the profile); the mock takes it
    // from the page language.
    handler: ({ params, now, siteUrl, locale }) =>
      ok({
        redirectUrl: buildPayLink(siteUrl, params.id ?? '', MOCK_PAY_TOKEN, locale),
        expiresAt: mockIntent('PENDING', now).expiresAt,
      }),
  },
  {
    method: 'GET',
    pattern: '/payments/pay/:intentId',
    handler: ({ params, headers, now, scenario }) => {
      // Like the real endpoint: a missing or wrong token is a plain 404, never a hint.
      if (headers[PAY_TOKEN_HEADER] !== MOCK_PAY_TOKEN) return fail('NOT_FOUND');
      const status = scenario === 'intentExpired' ? 'EXPIRED' : 'PENDING';
      return ok(mockPayView(status, now, params.intentId));
    },
  },
];
