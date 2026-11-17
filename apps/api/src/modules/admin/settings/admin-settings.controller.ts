import { Get, Query } from '@nestjs/common';
import type { AdminFxRate, AdminSettingsResponse } from '@repo/shared';
import type { WithMeta } from '../../../common/http/with-meta';
import { AdminAction } from '../common/admin-action.decorator';
import { AdminController } from '../common/admin-controller.decorator';
import { AdminFxHistoryQueryDto } from '../read/admin-read.dto';
import { AdminSettingsService } from './admin-settings.service';

// `GET /api/v1/admin/settings` and `GET /api/v1/admin/fx/history` (`settings.read`: OWNER and
// OPERATOR). The manual rate (`POST /admin/fx`) is phase 5's FxAdminService, 9-B.
@AdminController('')
export class AdminSettingsController {
  constructor(private readonly settings: AdminSettingsService) {}

  @AdminAction('settings.read')
  @Get('settings')
  list(): AdminSettingsResponse {
    return this.settings.settings();
  }

  @AdminAction('settings.read')
  @Get('fx/history')
  fxHistory(@Query() query: AdminFxHistoryQueryDto): Promise<WithMeta<readonly AdminFxRate[]>> {
    return this.settings.fxHistory(query);
  }
}
