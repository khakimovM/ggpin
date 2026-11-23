import { AdminConfirmationBodySchema, adminConfirmationCanonical } from '@repo/shared';
import { adminOf } from './fixtures';
import { updateJournal } from './mock-journal';
import { readMockState } from './mock-state';
import { codeNeeded } from './mock-step-up';
import { fail, ok, type MockRoute } from './router';

// `POST /admin/confirmations` of the dev mock: a well-formed body for an action that needs a code
// gets a challenge, stored with the body it is bound to (the write routes check it); an action
// that needs none now is refused with OTP_NOT_REQUIRED on `action`, as the API does (SA-M1).
function challengeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const confirmRoutes: readonly MockRoute[] = [
  {
    method: 'POST',
    pattern: '/admin/confirmations',
    handler: ({ body }) => {
      const state = readMockState();
      if (!state.signedIn) return fail('NOT_FOUND');
      const parsed = AdminConfirmationBodySchema.safeParse(body);
      if (!parsed.success) return fail('VALIDATION_ERROR', { fields: [] });
      if (!codeNeeded(parsed.data)) {
        return fail('VALIDATION_ERROR', { fields: [{ path: 'action', code: 'OTP_NOT_REQUIRED' }] });
      }
      const id = challengeId();
      const canonical = adminConfirmationCanonical(parsed.data);
      const adminId = adminOf(state.role).id;
      updateJournal((journal) => {
        journal.challenges[id] = { canonical, adminId };
      });
      return ok({ challengeId: id, expiresInSec: 180 });
    },
  },
];
