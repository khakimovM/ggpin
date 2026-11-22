// The OWNER-only CSV export of the audit log (GET /admin/audit-log/export.csv), as plain text.
import { AUDIT_EXPORT_COLUMNS, type AdminAuditRow } from '@repo/shared';
import type { MockRoute } from './router';

function cell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function fields(row: AdminAuditRow): Record<(typeof AUDIT_EXPORT_COLUMNS)[number], unknown> {
  return {
    id: row.id,
    createdAt: row.createdAt,
    actorType: row.actor.type,
    actorId: row.actor.id,
    actorName: row.actor.name,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    reason: row.reason,
    ip: row.ip,
    before: row.before,
    after: row.after,
  };
}

export function auditCsvRoute(rows: readonly AdminAuditRow[]): MockRoute {
  return {
    method: 'GET',
    pattern: '/admin/audit-log/export.csv',
    permission: 'audit.export',
    handler: () => ({
      status: 200,
      text: [
        AUDIT_EXPORT_COLUMNS.join(','),
        ...rows.map((row) => {
          const values = fields(row);
          return AUDIT_EXPORT_COLUMNS.map((column) => cell(values[column])).join(',');
        }),
      ].join('\n'),
    }),
  };
}
