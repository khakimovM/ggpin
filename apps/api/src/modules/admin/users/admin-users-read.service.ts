import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminNote,
  AdminOrderRow,
  AdminPaymentRow,
  AdminUserDetailResponse,
  AdminUserLedgerResponse,
  AdminUserListQuery,
  AdminUserReferralsResponse,
  AdminUserRow,
  AdminUserSessionsResponse,
  AdminUserTabQuery,
} from '@repo/shared';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { AppError } from '../../../common/exceptions/app-error';
import { paginated, type WithMeta } from '../../../common/http/with-meta';
import { toAdminOrderRow } from '../orders/admin-order-row.mapper';
import { AdminOrderRowsRepository } from '../orders/admin-order-rows.repository';
import { toAdminPaymentRow } from '../payments/admin-payments.mapper';
import { AdminPaymentsReadRepository } from '../payments/admin-payments-read.repository';
import { AdminBalancesRepository } from '../read/admin-balances.repository';
import { iso, isoOrNull, pageWindow, shownIp, type AdminReadView } from '../read/admin-read-view';
import {
  toAdminLedgerItem,
  toAdminNote,
  toAdminUserDetail,
  toAdminUserRow,
  type AdminUserFigures,
} from './admin-user.mapper';
import { AdminUsersReadRepository } from './admin-users-read.repository';

type Page<T> = Promise<WithMeta<readonly T[]>>;
const NO_FIGURES: AdminUserFigures = {
  balanceTiyin: 0n,
  deliveredCount: 0,
  deliveredPriceTiyin: 0n,
  deliveredDiscountTiyin: 0n,
};

/** The admin's read side of users (docs/04 «Foydalanuvchilar»). Every user, nothing written. */
@Injectable()
export class AdminUsersReadService {
  constructor(
    private readonly repo: AdminUsersReadRepository,
    private readonly balances: AdminBalancesRepository,
    private readonly orderRows: AdminOrderRowsRepository,
    private readonly paymentRows: AdminPaymentsReadRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(query: AdminUserListQuery): Page<AdminUserRow> {
    const { rows, total } = await this.repo.list(query, pageWindow(query));
    const figures = await this.figures(rows.map((row) => row.id));
    const items = rows.map((row) => toAdminUserRow(row, figures.get(row.id) ?? NO_FIGURES));
    return paginated(items, { page: query.page, limit: query.limit, total });
  }

  async detail(userId: string, view: AdminReadView): Promise<AdminUserDetailResponse> {
    const user = await this.repo.detail(userId);
    if (user === null) throw new AppError('NOT_FOUND');
    const [figures, activeSessionsCount, notes] = await Promise.all([
      this.figures([userId]),
      this.repo.activeWebSessions(userId, this.clock.now()),
      this.repo.notes(userId),
    ]);
    const shown = notes.rows
      .map((row) => toAdminNote(row, notes.authors))
      .filter((note): note is AdminNote => note !== null);
    const extras = { activeSessionsCount, notes: shown };
    return toAdminUserDetail(user, figures.get(userId) ?? NO_FIGURES, extras, view);
  }

  async orders(userId: string, query: AdminUserTabQuery): Page<AdminOrderRow> {
    await this.mustExist(userId);
    const { rows, total } = await this.orderRows.ofUser(userId, pageWindow(query));
    return paginated(rows.map(toAdminOrderRow), { page: query.page, limit: query.limit, total });
  }

  async ledger(userId: string, query: AdminUserTabQuery): Page<AdminUserLedgerResponse[number]> {
    await this.mustExist(userId);
    const { rows, total } = await this.repo.ledger(userId, pageWindow(query));
    return paginated(rows.map(toAdminLedgerItem), { page: query.page, limit: query.limit, total });
  }

  async payments(userId: string, query: AdminUserTabQuery): Page<AdminPaymentRow> {
    await this.mustExist(userId);
    const { rows, total } = await this.paymentRows.payments({ userId }, pageWindow(query));
    return paginated(rows.map(toAdminPaymentRow), { page: query.page, limit: query.limit, total });
  }

  async referrals(
    userId: string,
    query: AdminUserTabQuery,
  ): Page<AdminUserReferralsResponse[number]> {
    await this.mustExist(userId);
    const { rows, total } = await this.repo.referrals(userId, pageWindow(query));
    const items = rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
    return paginated(items, { page: query.page, limit: query.limit, total });
  }

  /** Web sessions only: the IP is masked for every role (the list says `ipMasked`). */
  async sessions(
    userId: string,
    query: AdminUserTabQuery,
  ): Page<AdminUserSessionsResponse[number]> {
    await this.mustExist(userId);
    const { rows, total } = await this.repo.sessions(userId, pageWindow(query));
    const items = rows.map((row) => ({
      id: row.id,
      userAgent: row.userAgent,
      ipMasked: shownIp(row.ip),
      createdAt: iso(row.createdAt),
      expiresAt: iso(row.expiresAt),
      revokedAt: isoOrNull(row.revokedAt),
    }));
    return paginated(items, { page: query.page, limit: query.limit, total });
  }

  private async mustExist(userId: string): Promise<void> {
    if (!(await this.repo.exists(userId))) throw new AppError('NOT_FOUND');
  }

  /** Balance (SUM(ledger) via the cache) and DELIVERED sums of a page of users, grouped. */
  private async figures(userIds: readonly string[]): Promise<Map<string, AdminUserFigures>> {
    if (userIds.length === 0) return new Map();
    const [balances, delivered] = await Promise.all([
      this.balances.of(userIds),
      this.repo.deliveredSums(userIds),
    ]);
    const sums = new Map(delivered.map((row) => [row.userId, row]));
    return new Map(
      userIds.map((id): [string, AdminUserFigures] => {
        const sum = sums.get(id);
        return [
          id,
          {
            balanceTiyin: balances.get(id) ?? 0n,
            deliveredCount: sum?._count._all ?? 0,
            deliveredPriceTiyin: sum?._sum.priceTiyin ?? 0n,
            deliveredDiscountTiyin: sum?._sum.discountTiyin ?? 0n,
          },
        ];
      }),
    );
  }
}
