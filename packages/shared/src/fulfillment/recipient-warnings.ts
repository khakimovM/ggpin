import type { RecipientWarning } from '../orders/order-schemas';
import type { RecipientNotice } from './recipient-check';

/**
 * The one place a worker notice becomes a client warning (docs/04 `POST /recipients/validate`,
 * `warnings[]`; owner Q3). `message` is an i18n key in the `warnings.*` namespace of
 * packages/i18n: the web renders it, the API never sends text.
 */
export const RECIPIENT_NOTICE_WARNINGS: Readonly<Record<RecipientNotice, RecipientWarning>> = {
  PREMIUM_EXTENDS: { code: 'PREMIUM_EXTENDS', message: 'warnings.premiumExtends' },
};

/** The warnings for a FOUND answer's notices: one per distinct notice, in the order given. */
export function recipientWarningsOf(
  notices: readonly RecipientNotice[] | undefined,
): RecipientWarning[] {
  return [...new Set(notices ?? [])].map((notice) => ({ ...RECIPIENT_NOTICE_WARNINGS[notice] }));
}
