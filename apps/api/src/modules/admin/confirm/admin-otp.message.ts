import type { AdminConfirmationBody } from '@repo/shared';
import { translate } from '../../../common/i18n/translate';
import { moneyText } from '../../notifications/owner-alert.renderer';
import { maskTelegramId } from '../admins/admin-allowlist';
import { adminConfirmFlagLabels } from './admin-otp-flags';

// The step-up code message (C-2 / SA-S6-2): the admin sees in Telegram WHAT the code confirms —
// the action's name, the signed amount, the account or card it touches and every flag the binding
// holds, in words (admin-otp-flags.ts) — so a panel session that was taken over cannot have a
// different body confirmed unseen.

type Locale = 'uz' | 'ru';

/** What the server read for the message; never the client's words. */
export interface AdminConfirmSubject {
  /** Signed: + money to the user, − money taken from them; unsigned: a limit. */
  readonly amount?: { readonly tiyin: bigint; readonly signed: boolean };
  readonly user?: { readonly username: string | null; readonly telegramId: bigint };
  readonly card?: { readonly bank: string; readonly last4: string };
}

const NONE = '—';

function amountText(locale: Locale, amount: AdminConfirmSubject['amount']): string {
  if (amount === undefined) return NONE;
  const text = moneyText(amount.tiyin, locale);
  return amount.signed && amount.tiyin > 0n ? `+${text}` : text;
}

function targetText(subject: AdminConfirmSubject): string {
  if (subject.card !== undefined) return `${subject.card.bank} ·${subject.card.last4}`;
  if (subject.user === undefined) return NONE;
  const masked = maskTelegramId(subject.user.telegramId);
  return subject.user.username === null ? masked : `@${subject.user.username} · ${masked}`;
}

/** The whole message; `code` stays right after the first colon (the panel's tests read it). */
export function adminConfirmText(
  locale: Locale,
  input: {
    readonly code: string;
    readonly body: AdminConfirmationBody;
    readonly serverFlags: readonly string[];
    readonly subject: AdminConfirmSubject;
  },
): string {
  const flags = adminConfirmFlagLabels(locale, input.body, input.serverFlags);
  // A card limit change shows its new limit, not a sum of money (owner decision 2026-11-18).
  const amountLabel = input.body.action === 'cards.limit' ? 'newLimit' : 'amount';
  return translate(locale, 'alerts.adminConfirm.code', {
    code: input.code,
    action: translate(locale, `alerts.adminConfirm.action.${input.body.action}`),
    amountLabel: translate(locale, `alerts.adminConfirm.label.${amountLabel}`),
    amount: amountText(locale, input.subject.amount),
    target: targetText(input.subject),
    flags: flags.length === 0 ? NONE : flags.join('; '),
  });
}
