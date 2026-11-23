import { Body, HttpCode, Inject, Ip, Param, Patch, Post, Res } from '@nestjs/common';
import {
  AdminCreateBodySchema,
  AdminManagementBodySchema,
  AdminUpdateBodySchema,
  type AdminAccountResponse,
  type AdminSessionsRevokeResponse,
} from '@repo/shared';
import { createZodDto } from 'nestjs-zod';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { IdempotencyKey } from '../../payments/idempotency-key.decorator';
import { clearAdminCookie, type AdminCookieReply } from '../auth/admin-cookies';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { CurrentAdmin } from '../common/current-admin.decorator';
import { adminResourceId } from '../read/admin-read-view';
import { AdminWriteRunner } from '../write/admin-write.runner';
import { AdminAccountsWriteReplays } from './admin-accounts-write.replays';
import { AdminPanelAccountsService } from './admin-panel-accounts.service';

// Bodies of the admin-management routes (the shared strict Zod schemas; `otp` is required by the
// schema itself, D-63 (4)), validated by the global ZodValidationPipe after the admin guards.
class AdminCreateBodyDto extends createZodDto(AdminCreateBodySchema) {}
class AdminUpdateBodyDto extends createZodDto(AdminUpdateBodySchema) {}
class AdminManagementBodyDto extends createZodDto(AdminManagementBodySchema) {}

// `/api/v1/admin/admins*` and `/api/v1/admin/sessions/:id/revoke` writes (docs/04 «Adminlar»,
// plan S9a): OWNER only (matrix `admins.*`, `sessions.revoke`), each on AdminWriteRunner
// (Idempotency-Key replay before any check) with the acting OWNER's code bound to the body this
// very request stands for. Two path roots, so the class sits on the admin segment itself.
@AdminController('')
export class AdminAccountsWriteController {
  constructor(
    private readonly runner: AdminWriteRunner,
    private readonly replays: AdminAccountsWriteReplays,
    private readonly accounts: AdminPanelAccountsService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'NODE_ENV'>,
  ) {}

  @AdminAction('admins.create')
  @Post('admins')
  @HttpCode(200)
  create(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @Body() body: AdminCreateBodyDto,
  ): Promise<AdminAccountResponse> {
    const { telegramId, name, role } = body;
    return this.runner.run(
      {
        ...{ principal, ip, key, body, otp: body.otp },
        // No row yet: the request's target is the Telegram id it asks for.
        targetId: telegramId,
        permission: 'admins.create',
        confirmation: () => ({ action: 'admins.create', telegramId, name, role }),
        replay: (row) => this.replays.account(row),
      },
      (actor) => this.accounts.create(actor, body),
    );
  }

  @AdminAction('admins.update')
  @Patch('admins/:id')
  update(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() body: AdminUpdateBodyDto,
  ): Promise<AdminAccountResponse> {
    const targetId = adminResourceId(id);
    const { name, role, isActive } = body;
    return this.runner.run(
      {
        ...{ principal, ip, key, body, targetId, otp: body.otp },
        permission: 'admins.update',
        confirmation: () => ({ action: 'admins.update', targetId, name, role, isActive }),
        replay: (row) => this.replays.account(row),
      },
      (actor) => this.accounts.update(actor, targetId, body),
    );
  }

  @AdminAction('admins.sessionsRevoke')
  @Post('admins/:id/sessions/revoke')
  @HttpCode(200)
  async revokeAdminSessions(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() body: AdminManagementBodyDto,
    @Res({ passthrough: true }) reply: AdminCookieReply,
  ): Promise<AdminSessionsRevokeResponse> {
    const targetId = adminResourceId(id);
    const result = await this.runner.run(
      {
        ...{ principal, ip, key, body, targetId, otp: body.otp },
        permission: 'admins.sessionsRevoke',
        confirmation: () => ({ action: 'admins.sessionsRevoke', targetId }),
        replay: (row) => this.replays.sessions(row, principal.sessionId),
      },
      (actor) => this.accounts.revokeAdminSessions(actor, targetId, body.reason),
    );
    return this.clearIfCurrent(reply, result);
  }

  @AdminAction('sessions.revoke')
  @Post('sessions/:id/revoke')
  @HttpCode(200)
  async revokeSession(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() body: AdminManagementBodyDto,
    @Res({ passthrough: true }) reply: AdminCookieReply,
  ): Promise<AdminSessionsRevokeResponse> {
    const targetId = adminResourceId(id);
    const result = await this.runner.run(
      {
        ...{ principal, ip, key, body, targetId, otp: body.otp },
        permission: 'sessions.revoke',
        confirmation: () => ({ action: 'sessions.revoke', targetId }),
        replay: (row) => this.replays.sessions(row, principal.sessionId),
      },
      (actor) => this.accounts.revokeSession(actor, targetId, body.reason),
    );
    return this.clearIfCurrent(reply, result);
  }

  /**
   * The caller's own session was ended (this call, or its replay from that very session): the
   * cookie goes too, like a logout (docs/04). `currentRevoked` already speaks of the caller.
   */
  private clearIfCurrent(
    reply: AdminCookieReply,
    result: AdminSessionsRevokeResponse,
  ): AdminSessionsRevokeResponse {
    if (result.currentRevoked) clearAdminCookie(reply, this.config.NODE_ENV);
    return result;
  }
}
