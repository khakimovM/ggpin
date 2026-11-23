import { Inject, Injectable } from '@nestjs/common';
import {
  adminOtpRequired,
  tashkentDayStart,
  type AdminAdjustOtpReason,
  type AdminAdjustPreview,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { APP_CONFIG, type AppConfig } from '../../../config/config.module';
import { recentSetHash, type RecentAutoTopup } from '../../wallet/wallet-admin.input';
import { WalletAdminService } from '../../wallet/wallet-admin.service';
import { openOrdersSetHash, type OpenOrder } from '../../wallet/wallet-open-orders';
import { WalletRepository } from '../../wallet/wallet.repository';
import { iso } from '../read/admin-read-view';

type PreviewConfig = Pick<
  AppConfig,
  'ADMIN_CONFIRM_THRESHOLD_TIYIN' | 'ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN'
>;

const magnitude = (tiyin: bigint): bigint => (tiyin < 0n ? -tiyin : tiyin);

/**
 * Why `users.adjustWallet` would ask for the code, in the matrix rule's own order: a credit
 * always (D-65 D1), a debit above the threshold, or past the admin's codeless daily budget.
 * `null` exactly when `adminOtpRequired` says no code (the unit test checks the two agree).
 */
export function adjustOtpReason(
  amountTiyin: bigint,
  thresholdTiyin: bigint,
  codelessBudgetExceeded: boolean,
): AdminAdjustOtpReason | null {
  if (amountTiyin > 0n) return 'CREDIT';
  if (magnitude(amountTiyin) > thresholdTiyin) return 'ABOVE_THRESHOLD';
  return codelessBudgetExceeded ? 'DAILY_BUDGET' : null;
}

function topupRow(payment: RecentAutoTopup): AdminAdjustPreview['recentAutoTopups'][number] {
  // The query reads `confirmedAt >= since`, so a row without it cannot come back.
  if (payment.confirmedAt === null) throw new Error(`payment ${payment.id} has no confirmedAt`);
  return {
    paymentId: payment.id,
    amountTiyin: payment.amountTiyin.toString(),
    confirmedAt: iso(payment.confirmedAt),
  };
}

function orderRow(order: OpenOrder): AdminAdjustPreview['openOrders'][number] {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    priceTiyin: order.priceTiyin.toString(),
    createdAt: iso(order.createdAt),
  };
}

/**
 * `GET /admin/users/:id/adjust-preview` (OWNER, `users.adjustPreview`; docs/04 «adjust-preview»):
 * what `POST /admin/users/:id/adjust-wallet` would meet now, computed with the very functions the
 * action and `POST /admin/confirmations` use (`recentFor`/`recentSetHash`, `openFor`/
 * `openOrdersSetHash`, `codelessFlags`, `adminOtpRequired`), so the two set ids it returns pass
 * the action unless a top-up or an order changes in between. Unlocked reads; writes nothing.
 */
@Injectable()
export class AdminAdjustPreviewService {
  constructor(
    private readonly wallet: WalletAdminService,
    private readonly repo: WalletRepository,
    @Inject(APP_CONFIG) private readonly config: PreviewConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async preview(adminId: string, userId: string, amountTiyin: bigint): Promise<AdminAdjustPreview> {
    // An unknown user is 404 and the admin's own account 400 SELF_TARGET, like the code (SA-S6-9).
    await this.wallet.confirmTarget(adminId, userId);
    const now = this.clock.now();
    const thresholdTiyin = this.config.ADMIN_CONFIRM_THRESHOLD_TIYIN;
    const [balance, recent, open, budget, usedTiyin] = await Promise.all([
      this.repo.balance(userId),
      this.wallet.recentFor(userId, amountTiyin, now),
      this.wallet.openFor(userId, amountTiyin),
      // A debit's codeless budget, as the confirmation reads it (a credit always needs the code).
      amountTiyin < 0n ? this.wallet.codelessFlags(adminId, amountTiyin, now) : Promise.resolve([]),
      this.repo.manualCreditTotalSinceUnlocked(tashkentDayStart(now)),
    ]);
    const codelessBudgetExceeded = budget.length > 0;
    return {
      balanceTiyin: balance.toString(),
      newBalanceTiyin: (balance + amountTiyin).toString(),
      otpRequired: adminOtpRequired('users.adjustWallet', {
        amountTiyin,
        thresholdTiyin,
        codelessBudgetExceeded,
      }),
      otpReason: adjustOtpReason(amountTiyin, thresholdTiyin, codelessBudgetExceeded),
      recentAutoTopups: recent.map(topupRow),
      confirmOverrideSet: recent.length > 0 ? recentSetHash(recent) : null,
      openOrders: open.map(orderRow),
      confirmOpenOrdersSet: open.length > 0 ? openOrdersSetHash(open) : null,
      manualCreditToday: {
        usedTiyin: usedTiyin.toString(),
        capTiyin: this.config.ADMIN_MANUAL_CREDIT_DAILY_CAP_TIYIN.toString(),
      },
    };
  }
}
