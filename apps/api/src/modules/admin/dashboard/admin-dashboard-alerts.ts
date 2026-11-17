import { Injectable, Logger } from '@nestjs/common';
import { scrubSecretsInText, type AdminDashboardResponse } from '@repo/shared';
import { BankFeedHealth } from '../../payments/bank-feed-health';
import { AdminQueuesReader } from '../infra/admin-queues.reader';
import { toAdminReconcileDay } from '../payments/admin-reconcile.mapper';
import { AdminPaymentsReadRepository } from '../payments/admin-payments-read.repository';
import { iso, isoOrNull } from '../read/admin-read-view';
import { AdminDashboardRepository } from './admin-dashboard.repository';

type Alert = AdminDashboardResponse['alerts'][number];

const alert = (
  kind: Alert['kind'],
  severity: Alert['severity'],
  count: number | null,
  since: Date | string | null,
): Alert => ({
  kind,
  severity,
  count,
  since: typeof since === 'string' ? since : isoOrNull(since),
});

/**
 * What needs attention now (docs/04 «Dashboard» `alerts`). FRAGMENT_SESSION_DEAD and the TON
 * alerts come from the worker's phase 5 health keys and join in 9-B; until then they are never
 * raised (not "all fine": the panel's infra page says they are not available yet).
 */
@Injectable()
export class AdminDashboardAlerts {
  private readonly logger = new Logger(AdminDashboardAlerts.name);

  constructor(
    private readonly repo: AdminDashboardRepository,
    private readonly payments: AdminPaymentsReadRepository,
    private readonly queues: AdminQueuesReader,
    private readonly bankFeed: BankFeedHealth,
  ) {}

  async current(): Promise<Alert[]> {
    const [review, held, reviews, failedJobs, reconcile, feedAlive] = await Promise.all([
      this.repo.ordersIn('NEEDS_REVIEW'),
      this.repo.ordersIn('HELD'),
      this.repo.openPaymentReviews(),
      this.failedJobs(),
      this.payments.reconcileRuns({ page: 1, limit: 1 }, { skip: 0, take: 1 }),
      this.bankFeed.isAlive(),
    ]);
    const alerts: Alert[] = [];
    if (review.count > 0)
      alerts.push(alert('ORDERS_NEEDS_REVIEW', 'critical', review.count, review.since));
    if (held.count > 0) alerts.push(alert('ORDERS_HELD', 'warning', held.count, held.since));
    if (reviews.count > 0) {
      alerts.push(alert('PAYMENT_REVIEWS_OPEN', 'warning', reviews.count, reviews.since));
    }
    // Unreadable queues are an alert too: nobody can tell whether jobs are failing.
    if (failedJobs === null || failedJobs > 0) {
      alerts.push(alert('QUEUE_FAILED_JOBS', 'warning', failedJobs, null));
    }
    const latest = reconcile.rows[0];
    if (latest !== undefined) {
      const day = toAdminReconcileDay(latest);
      if (!day.ok)
        alerts.push(alert('RECONCILE_MISMATCH', 'critical', null, iso(latest.createdAt)));
    }
    if (!feedAlive) alerts.push(alert('BANK_FEED_SILENT', 'critical', null, null));
    return alerts;
  }

  /** Failed jobs across all queues, or null when Redis does not answer. */
  private async failedJobs(): Promise<number | null> {
    try {
      const queues = await this.queues.counts();
      return queues.reduce((sum, queue) => sum + queue.failed, 0);
    } catch (error) {
      const reason =
        error instanceof Error ? scrubSecretsInText(error.message).slice(0, 200) : 'unknown';
      this.logger.warn(`queue counts unreadable: ${reason}`);
      return null;
    }
  }
}
