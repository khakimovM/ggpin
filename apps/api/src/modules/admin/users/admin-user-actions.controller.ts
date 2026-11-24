import { Body, HttpCode, Ip, Param, Post } from '@nestjs/common';
import type {
  AdminAdjustWalletResponse,
  AdminNoteResponse,
  AdminPermission,
  AdminUserSessionsRevokeResponse,
  AdminUserStateResponse,
} from '@repo/shared';
import type { AdminActor } from '../../../common/admin/audit-actor';
import { IdempotencyKey } from '../../payments/idempotency-key.decorator';
import { ReviewEffects } from '../../payments/review-effects';
import { WalletAdminService } from '../../wallet/wallet-admin.service';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { CurrentAdmin } from '../common/current-admin.decorator';
import { RequestReceivedAt } from '../../../common/http/request-received';
import { adminResourceId } from '../read/admin-read-view';
import { AdminWriteReplays } from '../write/admin-write.replays';
import { AdminWriteRunner } from '../write/admin-write.runner';
import {
  AdminAdjustWalletBodyDto,
  AdminNoteBodyDto,
  AdminReasonBodyDto,
} from '../write/admin-write.dto';
import { AdminUserActionsService, type UserStateChange } from './admin-user-actions.service';

type StateAction = (actor: AdminActor, userId: string, reason: string) => Promise<UserStateChange>;

interface Call<B> {
  readonly principal: AdminPrincipal;
  readonly ip: string;
  readonly receivedAtMs: number;
  readonly key: string;
  readonly id: string;
  readonly body: B;
}

// `POST /api/v1/admin/users/:id/*` (docs/04 «Foydalanuvchilar», D-63 (9)). Idempotency-Key on
// every route; the role is the guard's (matrix) and again the service's, read in its transaction.
@AdminController('users')
export class AdminUserActionsController {
  constructor(
    private readonly runner: AdminWriteRunner,
    private readonly replays: AdminWriteReplays,
    private readonly users: AdminUserActionsService,
    private readonly wallet: WalletAdminService,
    private readonly effects: ReviewEffects,
  ) {}

  @AdminAction('users.block')
  @Post(':id/block')
  @HttpCode(200)
  block(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminReasonBodyDto,
  ): Promise<AdminUserStateResponse> {
    const call = { principal, ip, receivedAtMs, key, id, body };
    return this.state(call, 'users.block', (a, u, r) => this.users.block(a, u, r));
  }

  @AdminAction('users.unblock')
  @Post(':id/unblock')
  @HttpCode(200)
  unblock(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminReasonBodyDto,
  ): Promise<AdminUserStateResponse> {
    const call = { principal, ip, receivedAtMs, key, id, body };
    return this.state(call, 'users.unblock', (a, u, r) => this.users.unblock(a, u, r));
  }

  @AdminAction('users.freeze')
  @Post(':id/freeze')
  @HttpCode(200)
  freeze(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminReasonBodyDto,
  ): Promise<AdminUserStateResponse> {
    const call = { principal, ip, receivedAtMs, key, id, body };
    return this.state(call, 'users.freeze', (a, u, r) => this.users.freeze(a, u, r));
  }

  @AdminAction('users.unfreeze')
  @Post(':id/unfreeze')
  @HttpCode(200)
  unfreeze(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminReasonBodyDto,
  ): Promise<AdminUserStateResponse> {
    const call = { principal, ip, receivedAtMs, key, id, body };
    return this.state(call, 'users.unfreeze', (a, u, r) => this.users.unfreeze(a, u, r));
  }

  @AdminAction('users.sessionsRevoke')
  @Post(':id/sessions/revoke')
  @HttpCode(200)
  revokeSessions(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminReasonBodyDto,
  ): Promise<AdminUserSessionsRevokeResponse> {
    const userId = adminResourceId(id);
    return this.runner.run(
      {
        ...{ principal, ip, receivedAtMs, key, body, targetId: userId },
        permission: 'users.sessionsRevoke',
        replay: (row) => this.replays.sessions(row),
      },
      (actor) => this.users.revokeSessions(actor, userId, body.reason),
    );
  }

  @AdminAction('users.note')
  @Post(':id/notes')
  @HttpCode(200)
  note(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminNoteBodyDto,
  ): Promise<AdminNoteResponse> {
    const userId = adminResourceId(id);
    return this.runner.run(
      {
        ...{ principal, ip, receivedAtMs, key, body, targetId: userId },
        permission: 'users.note',
        replay: (row) => this.replays.note(row),
      },
      async (actor) => {
        const done = await this.users.note(actor, userId, body.text);
        const author = { id: principal.admin.id, name: principal.admin.name };
        const createdAt = done.createdAt.toISOString();
        const note = { id: done.auditId, text: body.text, createdAt, author };
        return { note, auditId: done.auditId, applied: true };
      },
    );
  }

  /** WALLET_ADJUST through the owner CLI's service (docs/04, D-65 D1); OWNER only. */
  @AdminAction('users.adjustWallet')
  @Post(':id/adjust-wallet')
  @HttpCode(200)
  adjustWallet(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @IdempotencyKey() key: string,
    @RequestReceivedAt() receivedAtMs: number,
    @Param('id') id: string,
    @Body() body: AdminAdjustWalletBodyDto,
  ): Promise<AdminAdjustWalletResponse> {
    const userId = adminResourceId(id);
    const confirm = body.confirmAmountTiyin;
    const overrideSet = body.confirmOverrideSet;
    const override = overrideSet === undefined ? {} : { confirmOverrideSet: overrideSet };
    const openSet = body.confirmOpenOrdersSet;
    const open = openSet === undefined ? {} : { confirmOpenOrdersSet: openSet };
    return this.runner.run(
      {
        ...{ principal, ip, receivedAtMs, key, body, targetId: userId, otp: body.otp },
        permission: 'users.adjustWallet',
        // The code is bound to this very key too: one code moves money once (docs/04).
        confirmation: () => ({
          action: 'users.adjustWallet',
          targetId: userId,
          amountTiyin: confirm ?? body.amountTiyin,
          ...override,
          ...open,
          idempotencyKey: key,
        }),
        replay: (row) => this.replays.adjust(row),
      },
      async (actor) => {
        const change = await this.wallet.adjust({
          userId,
          amountTiyin: BigInt(body.amountTiyin),
          reason: body.reason,
          ...(confirm === undefined ? {} : { confirmAmountTiyin: BigInt(confirm) }),
          ...override,
          ...open,
          actor,
        });
        if (change.applied) await this.effects.adminAction(change.auditId);
        return {
          ledgerEntryId: change.ledgerEntryId,
          balanceTiyin: change.balanceTiyin.toString(),
          frozen: change.frozen,
          auditId: change.auditId,
          applied: change.applied,
        };
      },
    );
  }

  private state(
    call: Call<AdminReasonBodyDto>,
    permission: AdminPermission,
    action: StateAction,
  ): Promise<AdminUserStateResponse> {
    const userId = adminResourceId(call.id);
    const { principal, ip, receivedAtMs, key, body } = call;
    return this.runner.run(
      {
        ...{ principal, ip, receivedAtMs, key, body, targetId: userId, permission },
        replay: (row) => this.replays.userState(row),
      },
      (actor) => action(actor, userId, body.reason),
    );
  }
}
