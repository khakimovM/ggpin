import { Inject, Injectable } from '@nestjs/common';
import {
  FX_MAX_AGE_MS,
  FX_MAX_JUMP_BPS,
  QUOTE_TTL_MS,
  type AdminFxHistoryQuery,
  type AdminFxRate,
  type AdminSettingsResponse,
} from '@repo/shared';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { paginated, type WithMeta } from '../../../common/http/with-meta';
import { iso, pageWindow } from '../read/admin-read-view';
import { AdminFxReadRepository } from './admin-fx-read.repository';

type SettingItem = AdminSettingsResponse['items'][number];
type SettingsConfig = Pick<
  AppConfig,
  | 'TOPUP_MIN_TIYIN'
  | 'TOPUP_MAX_TIYIN'
  | 'TOPUP_STEP_TIYIN'
  | 'TOPUP_DAILY_MAX_TIYIN'
  | 'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN'
  | 'PRICE_TOLERANCE_BPS'
  | 'ADMIN_CONFIRM_THRESHOLD_TIYIN'
  | 'ADMIN_OPERATOR_REFUND_MAX_TIYIN'
>;

const env = (key: SettingItem['key'], value: bigint | number, unit: SettingItem['unit']) =>
  ({ key, value: value.toString(), unit, source: 'env' }) as const;
const constant = (key: SettingItem['key'], value: number, unit: SettingItem['unit']) =>
  ({ key, value: value.toString(), unit, source: 'constant' }) as const;

/**
 * The values that shape money and limits, read only (D-63 (8)): the API's env as loaded and the
 * shared constants. A fixed whitelist (`ADMIN_SETTING_KEYS`), so no secret can be added by
 * accident. `ADMIN_OTP_DAILY_MAX` and `ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN` join when their env
 * arrives with the step-up code (S6).
 */
export function settingItems(config: SettingsConfig): SettingItem[] {
  return [
    env('TOPUP_MIN_TIYIN', config.TOPUP_MIN_TIYIN, 'TIYIN'),
    env('TOPUP_MAX_TIYIN', config.TOPUP_MAX_TIYIN, 'TIYIN'),
    env('TOPUP_STEP_TIYIN', config.TOPUP_STEP_TIYIN, 'TIYIN'),
    env('TOPUP_DAILY_MAX_TIYIN', config.TOPUP_DAILY_MAX_TIYIN, 'TIYIN'),
    env('TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN', config.TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN, 'TIYIN'),
    env('PRICE_TOLERANCE_BPS', config.PRICE_TOLERANCE_BPS, 'BPS'),
    constant('QUOTE_TTL_MS', QUOTE_TTL_MS, 'MS'),
    constant('FX_MAX_AGE_MS', FX_MAX_AGE_MS, 'MS'),
    constant('FX_MAX_JUMP_BPS', FX_MAX_JUMP_BPS, 'BPS'),
    env('ADMIN_CONFIRM_THRESHOLD_TIYIN', config.ADMIN_CONFIRM_THRESHOLD_TIYIN, 'TIYIN'),
    env('ADMIN_OPERATOR_REFUND_MAX_TIYIN', config.ADMIN_OPERATOR_REFUND_MAX_TIYIN, 'TIYIN'),
  ];
}

/** `GET /admin/settings` and `GET /admin/fx/history` (OWNER and OPERATOR, D-65 D4). */
@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly fx: AdminFxReadRepository,
    @Inject(APP_CONFIG) private readonly config: SettingsConfig,
  ) {}

  settings(): AdminSettingsResponse {
    return { items: settingItems(this.config) };
  }

  async fxHistory(query: AdminFxHistoryQuery): Promise<WithMeta<readonly AdminFxRate[]>> {
    const { rows, total } = await this.fx.history(query.pair, pageWindow(query));
    const items = rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
    return paginated(items, { page: query.page, limit: query.limit, total });
  }
}
