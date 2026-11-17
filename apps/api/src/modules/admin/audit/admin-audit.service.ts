import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import {
  AUDIT_EXPORT_COLUMNS,
  csvRow,
  type AdminAuditExportQuery,
  type AdminAuditListQuery,
  type AdminAuditRow,
} from '@repo/shared';
import { paginated, type WithMeta } from '../../../common/http/with-meta';
import type { AdminPrincipal } from '../common/admin-request';
import { AdminThrottle } from '../common/admin-throttle';
import { adminReadView, pageWindow, type AdminReadView } from '../read/admin-read-view';
import { adminActorIds, toAdminAuditRow } from './admin-audit.mapper';
import { AdminAuditRepository, type AuditRowSource } from './admin-audit.repository';

const CRLF = '\r\n';
/** Rows read per query while the CSV streams (the whole export is at most 10 000). */
export const AUDIT_EXPORT_BATCH = 500;

/** One CSV line in `AUDIT_EXPORT_COLUMNS` order; `csvCell` neutralises formula-like cells. */
function exportLine(row: AdminAuditRow): string {
  const cells: Record<(typeof AUDIT_EXPORT_COLUMNS)[number], unknown> = {
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
  return csvRow(AUDIT_EXPORT_COLUMNS.map((column) => cells[column]));
}

/** The audit log for the panel (docs/04 «Audit log»): the list and the OWNER's CSV export. */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly repo: AdminAuditRepository,
    private readonly throttle: AdminThrottle,
  ) {}

  async list(
    query: AdminAuditListQuery,
    view: AdminReadView,
  ): Promise<WithMeta<readonly AdminAuditRow[]>> {
    const { page, limit, ...filter } = query;
    const { rows, total } = await this.repo.list(filter, pageWindow({ page, limit }));
    const names = await this.repo.adminNames(adminActorIds(rows));
    return paginated(
      rows.map((row) => toAdminAuditRow(row, names, view)),
      { page, limit, total },
    );
  }

  /**
   * The CSV export (SA-M8): counted against the session's 5 a minute, written to the audit log
   * BEFORE the first byte (an export that fails half way is still on record), then streamed in
   * keyset batches, newest first, redacted exactly like the list.
   */
  async export(
    principal: AdminPrincipal,
    ip: string,
    query: AdminAuditExportQuery,
  ): Promise<Readable> {
    await this.throttle.countExport(principal.sessionId);
    const { limit, ...filter } = query;
    await this.repo.recordExport({
      adminId: principal.admin.id,
      adminRole: principal.admin.role,
      ip,
      filters: { ...filter, limit },
    });
    const view = adminReadView(principal.admin.role);
    return Readable.from(this.lines(filter, limit, view), { objectMode: false });
  }

  private async *lines(
    filter: Omit<AdminAuditExportQuery, 'limit'>,
    limit: number,
    view: AdminReadView,
  ): AsyncGenerator<string> {
    // The header goes through the same cell writer as the data (every cell quoted, CR n1).
    yield csvRow(AUDIT_EXPORT_COLUMNS) + CRLF;
    let left = limit;
    let cursor: AuditRowSource | null = null;
    while (left > 0) {
      const take = Math.min(AUDIT_EXPORT_BATCH, left);
      const batch: AuditRowSource[] = await this.repo.exportBatch(filter, cursor, take);
      if (batch.length === 0) return;
      const names = await this.repo.adminNames(adminActorIds(batch));
      yield batch.map((row) => exportLine(toAdminAuditRow(row, names, view)) + CRLF).join('');
      left -= batch.length;
      cursor = batch[batch.length - 1] ?? null;
      if (batch.length < take) return;
    }
  }
}
