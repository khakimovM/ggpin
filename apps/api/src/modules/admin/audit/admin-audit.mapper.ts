import {
  AUDIT_ACTOR_TYPES,
  redactAuditJson,
  type AdminAuditRow,
  type AuditActorType,
} from '@repo/shared';
import { auditRedactionView, iso, shownIp, type AdminReadView } from '../read/admin-read-view';
import type { AuditRowSource } from './admin-audit.repository';

const isActorType = (value: string): value is AuditActorType =>
  (AUDIT_ACTOR_TYPES as readonly string[]).includes(value);

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * `before` / `after` as the reader may see them: secrets `[redacted]` for every role, IP and bank
 * message fields by role (shared `redactAuditJson`, SA-M4). Audit JSON is always an object today;
 * any other stored value is wrapped as `{ value }` so the shape stays a record.
 */
function shownJson(value: unknown, view: AdminReadView): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const redacted = redactAuditJson(asObject(value) ?? { value }, auditRedactionView(view));
  return asObject(redacted);
}

/** Who wrote the row: the admin's name, the CLI operator (`after.operator`), or nobody. */
function actorOf(row: AuditRowSource, adminNames: ReadonlyMap<string, string>) {
  // The column has no CHECK yet (9-B migration); a value outside the known three is shown as
  // SYSTEM rather than dropped, its id kept.
  const type: AuditActorType = isActorType(row.actorType) ? row.actorType : 'SYSTEM';
  let name: string | null = null;
  if (type === 'ADMIN' && row.actorId !== null) name = adminNames.get(row.actorId) ?? null;
  if (type === 'CLI') {
    const operator = asObject(row.after)?.['operator'];
    name = typeof operator === 'string' ? operator : null;
  }
  return { type, id: row.actorId, name };
}

export function toAdminAuditRow(
  row: AuditRowSource,
  adminNames: ReadonlyMap<string, string>,
  view: AdminReadView,
): AdminAuditRow {
  return {
    id: row.id,
    createdAt: iso(row.createdAt),
    actor: actorOf(row, adminNames),
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    before: shownJson(row.before, view),
    after: shownJson(row.after, view),
    reason: row.reason,
    // The row's own IP follows the same rule as IP keys inside the JSON (`audit.ipFull`).
    ip: view.ipFull ? row.ip : shownIp(row.ip),
  };
}

/** The ADMIN actor ids of a batch (for one name lookup). */
export function adminActorIds(rows: readonly AuditRowSource[]): string[] {
  const ids = rows.flatMap((row) =>
    row.actorType === 'ADMIN' && row.actorId !== null ? [row.actorId] : [],
  );
  return [...new Set(ids)];
}
