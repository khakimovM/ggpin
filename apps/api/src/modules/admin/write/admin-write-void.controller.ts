import { Body, HttpCode, Ip, Post } from '@nestjs/common';
import type { AdminWriteKeyVoidResponse } from '@repo/shared';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { CurrentAdmin } from '../common/current-admin.decorator';
import { RequestReceivedAt } from '../../../common/http/request-received';
import { AdminWriteVoidService } from './admin-write-void.service';
import { AdminWriteKeyVoidBodyDto } from './admin-write.dto';

// `POST /api/v1/admin/write-keys/void` (docs/04 «Kalitni bekor qilish», 9-B SA-1): any active
// admin, its own key only. No Idempotency-Key header (voiding a key twice is the same answer), no
// code and no reason (it moves no money); the guard's CSRF, session and write limit (30/min) hold.
@AdminController('write-keys')
export class AdminWriteVoidController {
  constructor(private readonly voids: AdminWriteVoidService) {}

  @AdminAction('writeKeys.void')
  @Post('void')
  @HttpCode(200)
  void(
    @CurrentAdmin() principal: AdminPrincipal,
    @Ip() ip: string,
    @Body() body: AdminWriteKeyVoidBodyDto,
    @RequestReceivedAt() receivedAtMs: number,
  ): Promise<AdminWriteKeyVoidResponse> {
    return this.voids.void(principal, ip, body, receivedAtMs);
  }
}
