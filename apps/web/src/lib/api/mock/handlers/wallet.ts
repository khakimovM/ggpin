import { LedgerQuerySchema } from '@repo/shared';
import { MOCK_WALLET, MOCK_WALLET_LOW, mockLedger } from '../fixtures/wallet';
import { fail, ok, page, type MockRoute } from '../router';

export const walletRoutes: readonly MockRoute[] = [
  {
    method: 'GET',
    pattern: '/me/wallet',
    handler: ({ scenario }) => ok(scenario === 'insufficient' ? MOCK_WALLET_LOW : MOCK_WALLET),
  },
  {
    method: 'GET',
    pattern: '/me/ledger',
    handler: ({ query, now }) => {
      const parsed = LedgerQuerySchema.safeParse(Object.fromEntries(query));
      if (!parsed.success) {
        return fail('VALIDATION_ERROR', {
          fields: parsed.error.issues.map((i) => i.path.join('.')),
        });
      }
      const { kind } = parsed.data;
      const entries = mockLedger(now).filter((entry) => kind === undefined || entry.kind === kind);
      return page(entries, query);
    },
  },
];
