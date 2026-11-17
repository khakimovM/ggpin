import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import type { AdminAuditExportQuery, AdminAuditListQuery } from '@repo/shared';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { dateRange } from '../read/admin-read-view';

export const AUDIT_ROW_SELECT = {
  id: true,
  createdAt: true,
  actorType: true,
  actorId: true,
  action: true,
  targetType: true,
  targetId: true,
  before: true,
  after: true,
  reason: true,
  ip: true,
} as const satisfies Prisma.AuditLogSelect;
export type AuditRowSource = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_ROW_SELECT }>;

type AuditFilter = Omit<AdminAuditListQuery, 'page' | 'limit'>;
type Page = { skip: number; take: number };
const NEWEST = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

/** The audit row of one CSV export (docs/04 «Audit log»: every export is itself audited). */
export interface AuditExportRecord {
  readonly adminId: string;
  /** The role the guard read on this request (plan §4.6): who could see what in the file. */
  readonly adminRole: string;
  readonly ip: string | null;
  readonly filters: Prisma.InputJsonObject;
}

function whereOf(filter: AuditFilter): Prisma.AuditLogWhereInput {
  return {
    actorType: filter.actorType,
    actorId: filter.actorId,
    action: filter.action,
    targetType: filter.targetType,
    targetId: filter.targetId,
    createdAt: dateRange(filter),
  };
}

// The audit log as the panel reads it (append-only: nothing here updates or deletes) and the one
// row an export adds.
@Injectable()
export class AdminAuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.client;
  }

  async list(filter: AuditFilter, page: Page) {
    const where = whereOf(filter);
    const [rows, total] = await this.db.$transaction([
      this.db.auditLog.findMany({ where, select: AUDIT_ROW_SELECT, orderBy: [...NEWEST], ...page }),
      this.db.auditLog.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * One page of the export, newest first, strictly after `cursor` (keyset on createdAt + id, so
   * rows written while the file streams cannot shift or repeat a page).
   */
  exportBatch(
    filter: Omit<AdminAuditExportQuery, 'limit'>,
    cursor: { createdAt: Date; id: string } | null,
    take: number,
  ): Promise<AuditRowSource[]> {
    const after: Prisma.AuditLogWhereInput =
      cursor === null
        ? {}
        : {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          };
    return this.db.auditLog.findMany({
      where: { AND: [whereOf(filter), after] },
      select: AUDIT_ROW_SELECT,
      orderBy: [...NEWEST],
      take,
    });
  }

  /** Display names of the admins among `ids` (actor of ADMIN rows). */
  async adminNames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const admins = await this.db.adminUser.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true },
    });
    return new Map(admins.map((admin) => [admin.id, admin.name]));
  }

  async recordExport(record: AuditExportRecord): Promise<string> {
    const row = await this.db.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: record.adminId,
        action: 'AUDIT_EXPORT',
        targetType: 'AuditLog',
        targetId: 'export',
        after: { ...record.filters, adminRole: record.adminRole },
        ip: record.ip,
      },
      select: { id: true },
    });
    return row.id;
  }
}
