// The ONE binding of an admin step-up code (docs/04 "Admin" — confirmations; review m-4). Both
// `POST /admin/confirmations` (issuance) and the confirmed action call `adminConfirmationBinding`
// with the body they parsed, so the two sides can never hash different things. Web Crypto, not
// `node:crypto`: this package is also bundled into the web and admin SPAs.
import { type AdminConfirmationBody, adminConfirmationCanonical } from './admin-confirm-schemas';

export interface AdminConfirmationBindingInput {
  /** The PARSED confirmation body (defaults filled); the action rebuilds it from its request. */
  readonly body: AdminConfirmationBody;
  /**
   * What the server computed itself under its locks and the code must also cover (the FX jump
   * flags, an override the rule raised …). Never from the client; order does not matter.
   */
  readonly serverFlags: readonly string[];
  readonly adminId: string;
  readonly sessionId: string;
}

/** The exact text that is hashed: `[canonical(body), sortedFlags, adminId, sessionId]` as JSON. */
export function adminConfirmationBindingText(input: AdminConfirmationBindingInput): string {
  const flags = [...input.serverFlags].sort();
  return JSON.stringify([
    adminConfirmationCanonical(input.body),
    flags,
    input.adminId,
    input.sessionId,
  ]);
}

/** sha256 (lower-case hex) of `adminConfirmationBindingText`. */
export async function adminConfirmationBinding(
  input: AdminConfirmationBindingInput,
): Promise<string> {
  const bytes = new TextEncoder().encode(adminConfirmationBindingText(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
