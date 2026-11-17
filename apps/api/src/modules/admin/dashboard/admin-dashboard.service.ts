import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AdminDashboardQuery, AdminDashboardResponse } from '@repo/shared';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { iso } from '../read/admin-read-view';
import { AdminDashboardAlerts } from './admin-dashboard-alerts';
import { AdminDashboardCache, type DashboardFigures } from './admin-dashboard.cache';
import { DashboardTally } from './admin-dashboard-figures';
import { dashboardPeriod, type DashboardPeriod } from './admin-dashboard-period';
import { AdminDashboardRepository, type DeliveredCursor } from './admin-dashboard.repository';

/** Delivered orders read per query: memory is one batch, whatever the period (SA-S4-1). */
export const DASHBOARD_BATCH = 2_000;
/** Optional override of the batch size (unit tests make it tiny to cross batch edges). */
export const DASHBOARD_BATCH_SIZE = Symbol('DASHBOARD_BATCH_SIZE');

/**
 * The cache key: no role (the figures do not depend on it). A preset is keyed by its start (its
 * end is "now" and moves every millisecond); a range by both of its ends.
 */
export function dashboardCacheKey(query: AdminDashboardQuery, period: DashboardPeriod): string {
  return query.period === 'range'
    ? `range:${iso(period.from)}:${iso(period.to)}`
    : `${query.period}:${iso(period.from)}`;
}

/** `GET /admin/dashboard` (OWNER and OPERATOR): the period's figures and what needs attention. */
@Injectable()
export class AdminDashboardService {
  private readonly logger = new Logger(AdminDashboardService.name);
  /** Single flight per process: concurrent requests for one key share one computation. */
  private readonly inFlight = new Map<string, Promise<DashboardFigures>>();
  private readonly batchSize: number;

  constructor(
    private readonly repo: AdminDashboardRepository,
    private readonly alerts: AdminDashboardAlerts,
    private readonly cache: AdminDashboardCache,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(DASHBOARD_BATCH_SIZE) batchSize?: number,
  ) {
    this.batchSize = batchSize ?? DASHBOARD_BATCH;
  }

  async dashboard(query: AdminDashboardQuery): Promise<AdminDashboardResponse> {
    const period = dashboardPeriod(query, this.clock.now());
    const [figures, alerts] = await Promise.all([
      this.figuresOf(dashboardCacheKey(query, period), period),
      this.alerts.current(),
    ]);
    return { ...figures, alerts };
  }

  private figuresOf(key: string, period: DashboardPeriod): Promise<DashboardFigures> {
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const work = this.cachedOrComputed(key, period).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }

  private async cachedOrComputed(key: string, period: DashboardPeriod): Promise<DashboardFigures> {
    const cached = await this.cache.get(key);
    if (cached !== null) return cached;
    const figures = await this.compute(period);
    await this.cache.set(key, figures);
    return figures;
  }

  private async compute(period: DashboardPeriod): Promise<DashboardFigures> {
    const [counts, tally] = await Promise.all([this.counts(period), this.tally(period)]);
    const names = await this.repo.productNames(tally.productIds());
    const { kpi, charts } = tally.result(counts, names);
    return { period: { from: iso(period.from), to: iso(period.to) }, kpi, charts };
  }

  private async counts(period: DashboardPeriod) {
    const [ordersCount, finalStates, newUsersCount, topups] = await Promise.all([
      this.repo.ordersCreated(period),
      this.repo.finalStates(period),
      this.repo.newUsers(period),
      this.repo.topupTotals(period),
    ]);
    return { ordersCount, finalStates, newUsersCount, topups };
  }

  /** Folds the delivered orders batch by batch (keyset on deliveredAt + id). */
  private async tally(period: DashboardPeriod): Promise<DashboardTally> {
    const tally = new DashboardTally(period);
    let cursor: DeliveredCursor | null = null;
    for (;;) {
      const batch = await this.repo.deliveredBatch(period, cursor, this.batchSize);
      try {
        tally.add(batch);
      } catch (error) {
        // Fail closed, and say which order (its id only: no amounts, no user data).
        this.logger.error(`dashboard profit refused for order ${tally.failedOrderId ?? '?'}`);
        throw error;
      }
      const last = batch[batch.length - 1];
      if (batch.length < this.batchSize || last === undefined || last.deliveredAt === null) {
        return tally;
      }
      cursor = { deliveredAt: last.deliveredAt, id: last.id };
    }
  }
}
