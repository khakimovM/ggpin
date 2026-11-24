import { camelKey, type CamelKey } from '../../lib/camel-key';
import {
  adminFieldErrors,
  isApiError,
  type ApiErrorMessageKey,
  type KnownAdminFieldCode,
} from '../../lib/api/errors';

/**
 * Domain refusals an admin write may name in `details.fields[].code` (docs/04 «Xatolar (admin)»
 * and the owner services' reason codes: wallet, review credit, cards, step-up). Each has a text in
 * `admin.fieldErrors.*`; `INVALID` is a field refused without a reason, `unknown` anything else.
 */
export const ACTION_FIELD_CODES = [
  'AMOUNT_MISMATCH',
  'MANUAL_CREDIT_DAILY_CAP',
  'SELF_TARGET',
  'ADMIN_ACCOUNT',
  'ALREADY_REVERSED',
  'RECENT_AUTO_TOPUP',
  'OPEN_ORDERS',
  'BANK_VERIFICATION_REQUIRED',
  'ALREADY_CREDITED',
  'RETURNED_OFFLINE',
  'AMOUNT_REALLOCATED',
  'MISMATCH',
  'CREDIT_UNDECIDED',
  'NOT_A_CHAIN_BREAK',
  'NOT_A_PARSED_CREDIT',
  'USER_BLOCKED',
  'DAILY_LIMIT',
  'NEW_ACCOUNT_DAILY_LIMIT',
  'GRACE_ELAPSED',
  'NO_SUCH_TRANSITION',
  'ACTOR_NOT_ALLOWED',
  'RESOLVED',
  'RETIRED',
  'SECURITY_PAUSE_OPEN',
  'OPEN_PAUSE_REVIEWS',
  'OTP_REQUIRED',
  'OTP_LOCKED',
  'OTP_UNAVAILABLE',
  'OTP_NOT_REQUIRED',
  'RATE_MISMATCH',
  // Catalog writes and the catalog price preview (S8a, docs/04 «Katalog»; CR m2).
  'DUPLICATE_PACKAGE',
  'PREMIUM_MONTHS',
  'PRODUCT_SET_MISMATCH',
  'QUANTITY_RANGE',
  'QTY_OUT_OF_RANGE',
  // Admin management (S9a, docs/04 «Adminlar»): a taken Telegram id; an OWNER row is the CLI's (Q7 a).
  'ADMIN_EXISTS',
  'OWNER_ROW',
  'INVALID',
] as const;
export type ActionFieldCode = (typeof ACTION_FIELD_CODES)[number];
// Every code `adminFieldCode` knows has a text here too (compile time).
type UntextedFieldCode = Exclude<KnownAdminFieldCode, ActionFieldCode>;
const everyKnownCodeTexted: [UntextedFieldCode] extends [never] ? true : never = true;
void everyKnownCodeTexted;

export type ActionErrorKey =
  | `admin.fieldErrors.${CamelKey<ActionFieldCode>}`
  | 'admin.fieldErrors.unknown'
  | 'admin.dialogs.failed'
  | ApiErrorMessageKey;

function knownCode(code: string): ActionFieldCode | undefined {
  return ACTION_FIELD_CODES.find((known) => known === code);
}

/** The first domain code of a refusal, when the panel knows it (`fields[]` order). */
export function actionFieldCode(error: unknown): ActionFieldCode | undefined {
  for (const field of adminFieldErrors(error)) {
    const code = knownCode(field.code);
    if (code !== undefined) return code;
  }
  return undefined;
}

/**
 * The i18n key of what went wrong: a domain code → `admin.fieldErrors.<code>`; another
 * `VALIDATION_ERROR` field → `admin.fieldErrors.unknown`; any other API error → its `errors.*`
 * text; a non-API failure → `admin.dialogs.failed`. Never server prose.
 */
export function actionErrorKey(error: unknown): ActionErrorKey {
  if (!isApiError(error)) return 'admin.dialogs.failed';
  const code = actionFieldCode(error);
  if (code !== undefined) return `admin.fieldErrors.${camelKey(code)}`;
  if (adminFieldErrors(error).length > 0) return 'admin.fieldErrors.unknown';
  return error.messageKey;
}
