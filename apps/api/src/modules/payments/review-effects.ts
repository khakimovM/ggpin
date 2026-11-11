import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { QUEUES, notifyJobId, notifyJobSchema, scrubSecretsInText } from '@repo/shared';
import type { Queue } from 'bullmq';
import { WalletCache } from '../wallet/wallet-cache';
import { NOTIFY_JOB_NAME, PaymentsAlerts } from './payments-alerts';

/**
 * What follows an owner decision on a review, AFTER its transaction committed (never inside:
 * a rolled-back credit must tell nobody anything). Best effort, like the card commands: the
 * decision is already stored, so a Redis hiccup is reported to the operator (`false`) instead
 * of failing the command; a retry of the command would only be refused as "already resolved".
 * Jobs carry ids only; the API renders the texts from the database later.
 */
@Injectable()
export class ReviewEffects {
  private readonly logger = new Logger(ReviewEffects.name);

  constructor(
    private readonly cache: WalletCache,
    private readonly alerts: PaymentsAlerts,
    @InjectQueue(QUEUES.NOTIFY) private readonly queue: Queue,
  ) {}

  /** The owner is told about every money or card action (`adminAction`, docs/05 §7). */
  async adminAction(auditId: string): Promise<boolean> {
    // Never throws: the decision is committed, so not even a malformed id may turn it into a
    // failed command (the operator would retry a done money action).
    try {
      return (await this.alerts.raise('adminAction', auditId)) !== null;
    } catch (error) {
      const reason = error instanceof Error ? scrubSecretsInText(error.message) : 'unknown error';
      this.logger.error(`adminAction for audit ${auditId} not queued: ${reason.slice(0, 200)}`);
      return false;
    }
  }

  /** A credit: drop the cached balance, tell the user, tell the owner. True when both jobs are queued. */
  async credited(userId: string, paymentId: string, auditId: string): Promise<boolean> {
    await this.cache.invalidate(userId);
    const user = await this.topupNotice(paymentId);
    const owner = await this.adminAction(auditId);
    return user && owner;
  }

  private async topupNotice(paymentId: string): Promise<boolean> {
    const job = notifyJobSchema.parse({ kind: 'TOPUP_CREDITED', refId: paymentId });
    try {
      await this.queue.add(NOTIFY_JOB_NAME, job, { jobId: notifyJobId(job) });
      return true;
    } catch (error) {
      // ioredis messages can quote the connection URL (password): scrubbed (I2).
      const reason = error instanceof Error ? scrubSecretsInText(error.message) : 'unknown error';
      this.logger.error(`top-up notice for payment ${paymentId} not queued: ${reason}`);
      return false;
    }
  }
}
