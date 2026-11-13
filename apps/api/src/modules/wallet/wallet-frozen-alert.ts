import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { NOTIFY_JOB_NAME, QUEUES, alertRef, notifyJobId, notifyJobSchema } from '@repo/shared';
import type { Queue } from 'bullmq';

/**
 * Tells the owner a wallet went negative and was frozen for purchases (`walletFrozen`, docs/05
 * section 10). The job carries ids only: the text and the amounts are rendered later from the
 * database, so no balance sits in Redis. Job id = `alert-walletFrozen-<userId>_<ledgerEntryId>`,
 * one per ledger write, so a retried producer alerts once.
 */
@Injectable()
export class WalletFrozenAlert {
  constructor(@InjectQueue(QUEUES.NOTIFY) private readonly queue: Queue) {}

  async raise(userId: string, ledgerEntryId: string): Promise<void> {
    const job = notifyJobSchema.parse({
      kind: 'OWNER_ALERT',
      alert: 'walletFrozen',
      refId: alertRef.walletFrozen(userId, ledgerEntryId),
    });
    await this.queue.add(NOTIFY_JOB_NAME, job, { jobId: notifyJobId(job) });
  }
}
