import { ResourceIdSchema, roleHas, type AdminRole, type AuditRedactionView } from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import { maskIp } from '../../auth/mask-ip';
import { maskTelegramId } from '../admins/admin-allowlist';

// What maskIp writes: IPv4 /24 (`203.0.113.x`) or IPv6 /48 (`2001:db8:85a3::x`).
const MASKED_IP = /^(\d{1,3}\.){3}x$|^[0-9a-f:]+::x$/i;

/**
 * An IP for a reader without `audit.ipFull`. Sessions store the address already masked (`maskIp`
 * at write), audit rows mostly in full: a full address is masked, a masked one passes through,
 * anything else is null (never shown raw).
 */
export function shownIp(ip: string | null | undefined): string | null {
  if (ip === null || ip === undefined) return null;
  const masked = maskIp(ip);
  if (masked !== null) return masked;
  return MASKED_IP.test(ip) ? ip : null;
}

/**
 * What one admin may see inside a read response beyond the route itself (docs/04 «Admin»,
 * «Hech qachon javobda emas», field-level rules). Built from the role the guard read from the
 * database on this request; the mappers never look at the role themselves.
 */
export interface AdminReadView {
  /** `users.phoneFull`: the phone as stored; otherwise masked. */
  readonly phoneFull: boolean;
  /** `payments.bankMessageRaw`: a bank message's text, balance after it and channel. */
  readonly bankMessageRaw: boolean;
  /** `audit.ipFull`: an audit row's IP as written; otherwise masked. */
  readonly ipFull: boolean;
}

export function adminReadView(role: AdminRole): AdminReadView {
  return {
    phoneFull: roleHas(role, 'users.phoneFull'),
    bankMessageRaw: roleHas(role, 'payments.bankMessageRaw'),
    ipFull: roleHas(role, 'audit.ipFull'),
  };
}

const TELEGRAM_ID = /^\d{1,19}$/;

/** A Telegram id inside audit JSON for a reader without the OWNER's view; junk is `null`. */
export function shownTelegramId(id: string): string | null {
  return TELEGRAM_ID.test(id) ? maskTelegramId(BigInt(id)) : null;
}

/**
 * The same view as the audit redactor takes it (shared `redactAuditJson`). Who an admin is outside
 * the panel (Telegram id, the CLI's OS user) follows the IP rule: OWNER only (SA-S4-3, variant a).
 */
export function auditRedactionView(view: AdminReadView): AuditRedactionView {
  return {
    ipFull: view.ipFull,
    bankMessageRaw: view.bankMessageRaw,
    maskIp: (ip) => shownIp(ip),
    identityFull: view.ipFull,
    maskTelegramId: (id) => shownTelegramId(id),
  };
}

/**
 * The `:id` of an admin read route. A malformed id names no row, so it is the same 404 as an
 * unknown one: the answer never teaches what an id looks like.
 */
export function adminResourceId(raw: string): string {
  const parsed = ResourceIdSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
}

/** `?page=&limit=` (already validated, limit <= 100) as Prisma's skip/take. */
export function pageWindow(query: { readonly page: number; readonly limit: number }): {
  skip: number;
  take: number;
} {
  return { skip: (query.page - 1) * query.limit, take: query.limit };
}

/** `from` inclusive, `to` exclusive (docs/04 «Umumiy qoidalar»), as a Prisma date filter. */
export function dateRange(range: {
  readonly from?: string;
  readonly to?: string;
}): { gte?: Date; lt?: Date } | undefined {
  if (range.from === undefined && range.to === undefined) return undefined;
  return {
    ...(range.from === undefined ? {} : { gte: new Date(range.from) }),
    ...(range.to === undefined ? {} : { lt: new Date(range.to) }),
  };
}

export const iso = (date: Date): string => date.toISOString();
export const isoOrNull = (date: Date | null): string | null => (date === null ? null : iso(date));
export const tiyinOrNull = (value: bigint | null): string | null =>
  value === null ? null : value.toString();
