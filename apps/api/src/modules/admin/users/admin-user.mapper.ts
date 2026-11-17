import {
  LEDGER_REF_TYPES,
  totalAfterDiscount,
  type AdminNote,
  type AdminUserDetailResponse,
  type AdminUserLedgerResponse,
  type AdminUserRow,
  type LedgerRefType,
} from '@repo/shared';
import { iso, isoOrNull, type AdminReadView } from '../read/admin-read-view';
import type { AdminUserDetailSource, AdminUserRowSource } from './admin-users-read.repository';

/** What a row needs beyond the user's own columns (read in grouped queries for a whole page). */
export interface AdminUserFigures {
  readonly balanceTiyin: bigint;
  /**
   * Count, Σ price and Σ discount of the user's DELIVERED orders, from ONE grouped query, so
   * `ordersCount` and `ordersTotalTiyin` describe the same orders (docs/04 does not define them
   * further; CR m2, docs note for S13).
   */
  readonly deliveredCount: number;
  readonly deliveredPriceTiyin: bigint;
  readonly deliveredDiscountTiyin: bigint;
}

/**
 * `+998901234567` -> `+998 ** *** ** 67` (docs/04: SUPPORT sees the phone masked). Only the
 * country code and the last two digits stay: enough to tell "is this the number the customer
 * gave on the phone", useless to call. Anything shorter than that is fully hidden.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '**';
  const last2 = digits.slice(-2);
  return digits.startsWith('998') ? `+998 ** *** ** ${last2}` : `+** *** ** ${last2}`;
}

export function toAdminUserRow(user: AdminUserRowSource, figures: AdminUserFigures): AdminUserRow {
  return {
    id: user.id,
    telegramId: user.telegramId.toString(),
    username: user.username,
    firstName: user.firstName,
    locale: user.locale,
    createdAt: iso(user.createdAt),
    lastSeenAt: isoOrNull(user.lastSeenAt),
    balanceTiyin: figures.balanceTiyin.toString(),
    ordersCount: figures.deliveredCount,
    ordersTotalTiyin: totalAfterDiscount(
      figures.deliveredPriceTiyin,
      figures.deliveredDiscountTiyin,
    ).toString(),
    referralsCount: user._count.referrals,
    isBlocked: user.isBlocked,
    purchaseFrozen: user.purchaseFrozen,
    botBlocked: user.botBlockedAt !== null,
  };
}

export interface AdminUserDetailExtras {
  readonly activeSessionsCount: number;
  readonly notes: readonly AdminNote[];
}

export function toAdminUserDetail(
  user: AdminUserDetailSource,
  figures: AdminUserFigures,
  extras: AdminUserDetailExtras,
  view: AdminReadView,
): AdminUserDetailResponse {
  const phone = user.phone === null ? null : view.phoneFull ? user.phone : maskPhone(user.phone);
  return {
    ...toAdminUserRow(user, figures),
    lastName: user.lastName,
    photoUrl: user.photoUrl,
    phone,
    referralCode: user.referralCode,
    referredBy: user.referredBy,
    activeSessionsCount: extras.activeSessionsCount,
    notes: [...extras.notes],
  };
}

/** A note row of the audit log (`after.text`); a row without text shows an empty note. */
export function toAdminNote(
  row: { id: string; actorId: string | null; after: unknown; createdAt: Date },
  authors: ReadonlyMap<string, string>,
): AdminNote | null {
  if (row.actorId === null) return null;
  const after = row.after;
  const text =
    typeof after === 'object' && after !== null && !Array.isArray(after)
      ? (after as Record<string, unknown>)['text']
      : undefined;
  return {
    id: row.id,
    text: typeof text === 'string' ? text : '',
    createdAt: iso(row.createdAt),
    author: { id: row.actorId, name: authors.get(row.actorId) ?? '' },
  };
}

const isRefType = (value: string): value is LedgerRefType =>
  (LEDGER_REF_TYPES as readonly string[]).includes(value);

type LedgerSource = {
  id: string;
  kind: AdminUserLedgerResponse[number]['kind'];
  amountTiyin: bigint;
  refType: string;
  refId: string;
  createdAt: Date;
};

export function toAdminLedgerItem(entry: LedgerSource): AdminUserLedgerResponse[number] {
  // refType is a CHECKed column (PAYMENT | ORDER | REFERRAL | ADMIN_ACTION): another value is a
  // broken invariant, not something to show.
  if (!isRefType(entry.refType)) throw new Error(`ledger entry ${entry.id} has an unknown refType`);
  return {
    id: entry.id,
    kind: entry.kind,
    amountTiyin: entry.amountTiyin.toString(),
    refType: entry.refType,
    refId: entry.refId,
    createdAt: iso(entry.createdAt),
  };
}
