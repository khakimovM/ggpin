import { ADMIN_CODELESS_BUDGET_FLAG, type AdminConfirmationBody } from '@repo/shared';
import { translate } from '../../../common/i18n/translate';
import { moneyText } from '../../notifications/owner-alert.renderer';

// The admin reads every flag the code is bound to in their own language (owner decision
// 2026-11-18). Only the WORDS change: the binding keeps the raw flags, and a flag this file does
// not know is shown as it is, never hidden, so a new server flag can never slip past unseen.

type Locale = 'uz' | 'ru';

const FLAG = 'alerts.adminConfirm.flag';

/** `override: N recent auto top-up(s), set <hash>` (wallet-admin.input.ts adjustOtpFlags). */
const RECENT_TOPUPS = /^override: (\d+) recent auto top-up\(s\), set ([0-9a-f]{12})$/;
/** `open orders: N open order(s), set <hash>` (wallet-open-orders.ts openOrdersFlag, I-5). */
const OPEN_ORDERS = /^open orders: (\d+) open order\(s\), set ([0-9a-f]{12})$/;
/** `override: blocked, overLimit` (review-credit.checks.ts creditOtpFlags). */
const USER_OVERRIDE = /^override: ((?:blocked|overLimit)(?:, (?:blocked|overLimit))*)$/;

const USER_WARNING: Readonly<Record<string, string>> = {
  blocked: 'userBlocked',
  overLimit: 'userOverLimit',
};

function serverFlagLabel(locale: Locale, flag: string): string {
  if (flag === 'bank-verified') return translate(locale, `${FLAG}.bankVerified`);
  if (flag === ADMIN_CODELESS_BUDGET_FLAG) return translate(locale, `${FLAG}.dailyLimit`);
  if (flag === 'override: none') return translate(locale, `${FLAG}.overrideNone`);
  const recent = RECENT_TOPUPS.exec(flag);
  if (recent !== null) {
    return translate(locale, `${FLAG}.overrideRecentTopups`, {
      count: recent[1] ?? '',
      set: recent[2] ?? '',
    });
  }
  const open = OPEN_ORDERS.exec(flag);
  if (open !== null) {
    return translate(locale, `${FLAG}.openOrders`, { count: open[1] ?? '', set: open[2] ?? '' });
  }
  const user = USER_OVERRIDE.exec(flag);
  if (user !== null) {
    const what = (user[1] ?? '')
      .split(', ')
      .map((w) => translate(locale, `${FLAG}.${USER_WARNING[w] ?? w}`));
    return translate(locale, `${FLAG}.overrideUser`, { what: what.join(', ') });
  }
  return flag;
}

/**
 * The body's own confirmations (the binding holds them) and the server's flags, in words. One
 * server flag may hold several joined by `; ` (`override: blocked; bank-verified`): each is shown.
 */
export function adminConfirmFlagLabels(
  locale: Locale,
  body: AdminConfirmationBody,
  serverFlags: readonly string[],
): string[] {
  const labels: string[] = [];
  // A review credit's and an adjustment's override are in the server's flags already.
  if (body.action === 'cards.resume') {
    if (body.confirmOverride) labels.push(translate(locale, `${FLAG}.confirmOverride`));
    if (body.confirmSecurityPause) labels.push(translate(locale, `${FLAG}.confirmSecurityPause`));
  }
  if (body.action === 'cards.retire' && body.emergency) {
    labels.push(translate(locale, `${FLAG}.emergency`));
  }
  if (body.action === 'cards.limit' && body.monthlyLimitTiyin !== undefined) {
    const monthly = body.monthlyLimitTiyin;
    labels.push(
      monthly === null
        ? translate(locale, `${FLAG}.monthlyLimitRemoved`)
        : translate(locale, `${FLAG}.monthlyLimit`, {
            amount: moneyText(BigInt(monthly), locale),
          }),
    );
  }
  for (const joined of serverFlags) {
    for (const flag of joined.split('; ')) {
      if (flag !== '') labels.push(serverFlagLabel(locale, flag));
    }
  }
  return labels;
}
