// `POST /admin/confirmations` (docs/04 "Tasdiq kodi"): asks the API to send a step-up code to the
// acting admin's own Telegram. No Idempotency-Key: issuing a code changes nothing.
import {
  AdminConfirmationResponseSchema,
  type AdminConfirmationBody,
  type AdminConfirmationResponse,
} from '@repo/shared';
import { apiFetch } from './client';

export function requestConfirmation(
  body: AdminConfirmationBody,
): Promise<AdminConfirmationResponse> {
  return apiFetch(
    { method: 'POST', path: '/admin/confirmations', body, group: 'confirmations' },
    AdminConfirmationResponseSchema,
  );
}
