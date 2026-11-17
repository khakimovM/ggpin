import { Get, Query } from '@nestjs/common';
import type { AdminDashboardResponse } from '@repo/shared';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import { AdminDashboardQueryDto } from '../read/admin-read.dto';
import { AdminDashboardService } from './admin-dashboard.service';

// `GET /api/v1/admin/dashboard` (`dashboard.read`: OWNER and OPERATOR, D-65 D4).
@AdminController('dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @AdminAction('dashboard.read')
  @Get()
  get(@Query() query: AdminDashboardQueryDto): Promise<AdminDashboardResponse> {
    return this.dashboard.dashboard(query);
  }
}
