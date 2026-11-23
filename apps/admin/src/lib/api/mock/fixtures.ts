// Fixture data of the dev mock. Every object is parsed with the endpoint's shared response schema
// when this module loads, so a fixture that drifts from the contract fails at once (and in the
// unit test that imports it), instead of teaching the UI a shape the real API never sends.
import {
  AdminLoginVerifyResponseSchema,
  AdminMeResponseSchema,
  permissionsFor,
  type AdminLoginVerifyResponse,
  type AdminMeResponse,
  type AdminRole,
} from '@repo/shared';

/** The bot the mock login "opens"; the real link comes from the API (`botUrl`). */
export const MOCK_BOT_USERNAME = 'ggpin_mock_bot';

/** Entering this code in the mock login is a wrong code (as in Login.dc.html). */
export const MOCK_WRONG_CODE = '000000';
export const MOCK_ATTEMPTS = 5;

/** The mock admins (one per role); the write routes act as `adminOf(mockRole())`. */
const NAMES: Record<AdminRole, string> = {
  OWNER: 'Aziz O.',
  OPERATOR: 'Dilshod K.',
  SUPPORT: 'Malika R.',
};

export function adminOf(role: AdminRole): AdminMeResponse['admin'] {
  return {
    id: `cmadmin${role.toLowerCase()}mock000000001`.slice(0, 25),
    name: NAMES[role],
    role,
    telegramIdMasked: '12******89',
  };
}

export function meFixture(role: AdminRole, now: Date): AdminMeResponse {
  return AdminMeResponseSchema.parse({
    admin: adminOf(role),
    permissions: permissionsFor(role),
    limits: { operatorRefundMaxTiyin: '50000000', confirmThresholdTiyin: '10000000' },
    session: {
      expiresAt: new Date(now.getTime() + 8 * 3600_000).toISOString(),
      idleExpiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    },
  });
}

export function verifyFixture(role: AdminRole): AdminLoginVerifyResponse {
  return AdminLoginVerifyResponseSchema.parse({ admin: adminOf(role) });
}
