import {
  ValidateRecipientResponseSchema,
  type ValidateRecipientBody,
  type ValidateRecipientResponse,
} from '@repo/shared';
import { apiFetch } from './client';

// The shared schema is still a phase 5 DRAFT (docs/04); the mock group stays on until it is final.

/** Confirms the recipient before payment (invariant 8); the token goes into the quote request. */
export function validateRecipient(
  body: ValidateRecipientBody,
  signal?: AbortSignal,
): Promise<ValidateRecipientResponse> {
  return apiFetch(
    { method: 'POST', path: '/recipients/validate', body, group: 'recipients', signal },
    ValidateRecipientResponseSchema,
  );
}
