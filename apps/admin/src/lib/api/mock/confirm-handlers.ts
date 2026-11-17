import { AdminConfirmationBodySchema } from '@repo/shared';
import { readMockState } from './mock-state';
import { fail, ok, type MockRoute } from './router';

// `POST /admin/confirmations` of the dev mock: any well-formed body gets a challenge; the code
// "sent to Telegram" is checked by the action routes of later slices (S5).
function challengeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const confirmRoutes: readonly MockRoute[] = [
  {
    method: 'POST',
    pattern: '/admin/confirmations',
    handler: ({ body }) => {
      if (!readMockState().signedIn) return fail('NOT_FOUND');
      const parsed = AdminConfirmationBodySchema.safeParse(body);
      if (!parsed.success) return fail('VALIDATION_ERROR', { fields: [] });
      return ok({ challengeId: challengeId(), expiresInSec: 180 });
    },
  },
];
