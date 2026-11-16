import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import {
  NOTIFY_JOB_NAME,
  QUEUES,
  describeErrorForLog,
  notifyJobId,
  notifyJobSchema,
  type FulfillmentAlertKind,
  type NotifyJob,
  type OrderEffectsPlan,
} from '@repo/shared';
import { WalletCacheInvalidator } from '../../bank-feed/wallet-cache-invalidator';
import type { NoticeQueue } from '../../ton/ton-notifier';

// The order reconciler's after-commit effects (phase 5 S9, plan §4.2): never inside a transaction,
// always with stable job ids (notifyJobId, 30-day dedupe), so a repeated tick or a crash between
// commit and queue re-adds the same ids and nobody hears anything twice. The plan of a resolution
// is the shared `effectsOf` (the same ids the API and the S9h audit sweep produce). Ids only: the
// API renders every text. A failure is logged and reported as `false`, never thrown: the decision
// stands (the S9h audit sweep restores lost effects from the audit row).

@Injectable()
export class ReconcileNotifier {
  private readonly logger = new Logger(ReconcileNotifier.name);

  constructor(
    @InjectQueue(QUEUES.NOTIFY) private readonly queue: NoticeQueue,
    private readonly wallets: WalletCacheInvalidator,
  ) {}

  /** One owner alert; false when it could not be queued. */
  alert(alert: FulfillmentAlertKind, refId: string): Promise<boolean> {
    return this.add({ kind: 'OWNER_ALERT', alert, refId });
  }

  /** The cached balance first (a REFUND entry was written), then every job in the plan's order. */
  async run(plan: OrderEffectsPlan): Promise<boolean[]> {
    const user = plan.invalidateWalletOf;
    if (user !== null) {
      try {
        await this.wallets.invalidate(user);
      } catch (error) {
        this.logger.error(`wallet cache not invalidated: ${describeErrorForLog(error, 200)}`);
      }
    }
    const queued: boolean[] = [];
    for (const job of plan.notifyJobs) queued.push(await this.add(job));
    return queued;
  }

  private async add(job: NotifyJob): Promise<boolean> {
    const parsed = notifyJobSchema.safeParse(job);
    if (!parsed.success) {
      this.logger.error(`reconcile notice ${job.kind} has an invalid id: not queued`);
      return false;
    }
    const jobId = notifyJobId(parsed.data);
    try {
      await this.queue.add(NOTIFY_JOB_NAME, parsed.data, { jobId });
      return true;
    } catch (error) {
      this.logger.error(`reconcile notice ${jobId} not queued: ${describeErrorForLog(error, 200)}`);
      return false;
    }
  }
}
