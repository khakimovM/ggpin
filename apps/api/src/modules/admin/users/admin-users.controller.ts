import { Get, Param, Query } from '@nestjs/common';
import type {
  AdminAdjustPreview,
  AdminOrderRow,
  AdminPaymentRow,
  AdminUserDetailResponse,
  AdminUserLedgerResponse,
  AdminUserReferralsResponse,
  AdminUserRow,
  AdminUserSessionsResponse,
} from '@repo/shared';
import type { WithMeta } from '../../../common/http/with-meta';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { CurrentAdmin } from '../common/current-admin.decorator';
import { withAdminFieldErrors } from '../read/admin-domain-error';
import {
  AdminAdjustPreviewQueryDto,
  AdminUserListQueryDto,
  AdminUserTabQueryDto,
} from '../read/admin-read.dto';
import { adminReadView, adminResourceId } from '../read/admin-read-view';
import { AdminAdjustPreviewService } from './admin-adjust-preview.service';
import { AdminUsersReadService } from './admin-users-read.service';

type Page<T> = Promise<WithMeta<readonly T[]>>;

// `GET /api/v1/admin/users/*` (docs/04 «Foydalanuvchilar»): every role reads; SUPPORT sees the
// phone masked (`users.phoneFull`). The write routes (block, freeze, notes, ...) are S6; the
// adjust preview (S7a) is OWNER's.
@AdminController('users')
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersReadService,
    private readonly adjust: AdminAdjustPreviewService,
  ) {}

  @AdminAction('users.read')
  @Get()
  list(@Query() query: AdminUserListQueryDto): Page<AdminUserRow> {
    return this.users.list(query);
  }

  @AdminAction('users.read')
  @Get(':id')
  detail(
    @CurrentAdmin() principal: AdminPrincipal,
    @Param('id') id: string,
  ): Promise<AdminUserDetailResponse> {
    return this.users.detail(adminResourceId(id), adminReadView(principal.admin.role));
  }

  @AdminAction('users.read')
  @Get(':id/orders')
  orders(@Param('id') id: string, @Query() query: AdminUserTabQueryDto): Page<AdminOrderRow> {
    return this.users.orders(adminResourceId(id), query);
  }

  @AdminAction('users.read')
  @Get(':id/ledger')
  ledger(
    @Param('id') id: string,
    @Query() query: AdminUserTabQueryDto,
  ): Page<AdminUserLedgerResponse[number]> {
    return this.users.ledger(adminResourceId(id), query);
  }

  @AdminAction('users.read')
  @Get(':id/payments')
  payments(@Param('id') id: string, @Query() query: AdminUserTabQueryDto): Page<AdminPaymentRow> {
    return this.users.payments(adminResourceId(id), query);
  }

  @AdminAction('users.read')
  @Get(':id/referrals')
  referrals(
    @Param('id') id: string,
    @Query() query: AdminUserTabQueryDto,
  ): Page<AdminUserReferralsResponse[number]> {
    return this.users.referrals(adminResourceId(id), query);
  }

  @AdminAction('users.read')
  @Get(':id/sessions')
  sessions(
    @Param('id') id: string,
    @Query() query: AdminUserTabQueryDto,
  ): Page<AdminUserSessionsResponse[number]> {
    return this.users.sessions(adminResourceId(id), query);
  }

  /** What an adjustment would meet now (I-5, S7a); OWNER only, writes nothing. */
  @AdminAction('users.adjustPreview')
  @Get(':id/adjust-preview')
  adjustPreview(
    @CurrentAdmin() principal: AdminPrincipal,
    @Param('id') id: string,
    @Query() query: AdminAdjustPreviewQueryDto,
  ): Promise<AdminAdjustPreview> {
    const userId = adminResourceId(id);
    const amountTiyin = BigInt(query.amountTiyin);
    return withAdminFieldErrors(() => this.adjust.preview(principal.admin.id, userId, amountTiyin));
  }
}
