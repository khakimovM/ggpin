import { Get, HttpCode, HttpStatus, Module, Post } from '@nestjs/common';
import { ADMIN_ROLES } from '@repo/shared';
import { AdminController } from '../common/admin-controller.decorator';
import type { AdminPrincipal } from '../common/admin-request';
import { AdminRoles } from '../common/admin-role.decorator';
import { CurrentAdmin } from '../common/current-admin.decorator';

// Test-only admin routes (e2e): S2 ships only the auth routes, so the role check, the write limit
// and the fail-closed default are proven on these. Mounted under /api/v1/admin/e2e-probe by the
// e2e harness only; never part of AppModule.
@AdminController('e2e-probe')
class AdminProbeController {
  @AdminRoles('OWNER', 'OPERATOR')
  @Get('staff')
  staff(@CurrentAdmin() principal: AdminPrincipal): { role: string } {
    return { role: principal.admin.role };
  }

  @AdminRoles(...ADMIN_ROLES)
  @HttpCode(HttpStatus.OK)
  @Post('write')
  write(): Record<string, never> {
    return {};
  }

  // No @AdminRoles / @AdminAction: nobody may call it (AdminGuard fails closed).
  @Get('unmarked')
  unmarked(): Record<string, never> {
    return {};
  }
}

@Module({ controllers: [AdminProbeController] })
export class AdminProbeModule {}
