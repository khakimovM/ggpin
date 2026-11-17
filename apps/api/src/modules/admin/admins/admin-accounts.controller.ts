import { Get, Param } from '@nestjs/common';
import type { AdminAccountListResponse, AdminSessionListResponse } from '@repo/shared';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { CurrentAdmin } from '../common/current-admin.decorator';
import { adminResourceId } from '../read/admin-read-view';
import { AdminAccountsReadService } from './admin-accounts-read.service';

// `GET /api/v1/admin/admins*` (OWNER only, `admins.read`). The writes (add, change, revoke)
// arrive in S9 with the step-up code.
@AdminController('admins')
export class AdminAccountsController {
  constructor(private readonly accounts: AdminAccountsReadService) {}

  @AdminAction('admins.read')
  @Get()
  list(): Promise<AdminAccountListResponse> {
    return this.accounts.list();
  }

  @AdminAction('admins.read')
  @Get(':id/sessions')
  sessions(
    @CurrentAdmin() principal: AdminPrincipal,
    @Param('id') id: string,
  ): Promise<AdminSessionListResponse> {
    return this.accounts.sessions(adminResourceId(id), principal.sessionId);
  }
}
