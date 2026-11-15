import { ManualFxPairSchema, ManualFxRateSchema, fxRateMoveBps } from '@repo/shared';
import { translate } from '../../common/i18n/translate';

// The `{action}` of the owner's adminAction alert. Most audited actions are named by their code
// (`WALLET_ADJUST`, `ORDER_RETRY`): the owner opens the audit row by its id. An FX_SET also says what
// changed (audit L-2): the pair, the previous rate, the new one and the move in basis points, read
// from its own AuditLog row (an exchange rate is not a secret). A row that does not fit falls back
// to the bare code: the alert is never lost over its detail.

type Json = { readonly [key: string]: unknown };

function objectOf(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** A rate the money module can read: a positive plain decimal (any source wrote it). */
function rateOf(value: unknown): string | null {
  const parsed = ManualFxRateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface AuditForAlert {
  readonly action: string;
  readonly before: unknown;
  readonly after: unknown;
}

/** Owner alerts are in the owner's language (Uzbek, OwnerAlertRenderer) unless told otherwise. */
export function adminActionText(audit: AuditForAlert, locale: 'uz' | 'ru' = 'uz'): string {
  if (audit.action !== 'FX_SET') return audit.action;
  const after = objectOf(audit.after);
  const pair = ManualFxPairSchema.safeParse(after?.['pair']);
  const to = rateOf(after?.['rate']);
  if (!pair.success || to === null) return audit.action;
  const from = rateOf(objectOf(objectOf(audit.before)?.['previous'])?.['rate']);
  return translate(locale, 'alerts.adminActionDetail.FX_SET', {
    pair: pair.data,
    from: from ?? '-',
    to,
    bps: from === null ? '-' : fxRateMoveBps(pair.data, from, to).toString(),
  });
}
