import { Get, Ip, Query, Req, StreamableFile } from '@nestjs/common';
import type { AdminAuditRow } from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import type { WithMeta } from '../../../common/http/with-meta';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { CurrentAdmin } from '../common/current-admin.decorator';
import { AdminAuditExportQueryDto, AdminAuditListQueryDto } from '../read/admin-read.dto';
import { adminReadView } from '../read/admin-read-view';
import { AdminAuditService } from './admin-audit.service';

const CSV_TYPE = 'text/csv; charset=utf-8';
const CSV_DISPOSITION = 'attachment; filename="audit-log.csv"';

// `GET /api/v1/admin/audit-log` (OWNER, OPERATOR; IPs masked for OPERATOR) and its CSV export
// (OWNER only, audited as AUDIT_EXPORT). The export is a plain `text/csv` body, not the JSON
// envelope; an error before the first byte is still the usual JSON envelope.
@AdminController('audit-log')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @AdminAction('audit.read')
  @Get()
  list(
    @CurrentAdmin() principal: AdminPrincipal,
    @Query() query: AdminAuditListQueryDto,
  ): Promise<WithMeta<readonly AdminAuditRow[]>> {
    return this.audit.list(query, adminReadView(principal.admin.role));
  }

  @AdminAction('audit.export')
  @Get('export.csv')
  async exportCsv(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @Query() query: AdminAuditExportQueryDto,
    @Req() request: { readonly method: string },
  ): Promise<StreamableFile> {
    // Fastify answers HEAD with the GET handler: a HEAD would run (and audit) a whole export whose
    // bytes are thrown away (SA-S4-6). It is the unknown-route 404 instead, before anything runs.
    if (request.method !== 'GET') throw new AppError('NOT_FOUND');
    const stream = await this.audit.export(principal, ip, query);
    return new StreamableFile(stream, { type: CSV_TYPE, disposition: CSV_DISPOSITION });
  }
}
