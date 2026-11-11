import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { AUTO_CREDIT_HORIZON_MS } from '@repo/db';
import { QUEUES, bankMessageJobId } from '@repo/shared';
import type { Queue } from 'bullmq';
import { PrismaService } from '../infra/prisma/prisma.service';
import { bankMessageJobSchema } from './bank-message.processor';
import { BANK_MESSAGE_JOB_NAME } from './client/ingest.service';

/** A stored message younger than this may still be in its first job: it is not an orphan yet. */
export const OUTCOME_SETTLE_MS = 15 * 60 * 1000;
/**
 * Only messages stored this recently are re-queued; older ones are the reconcile's to report. The
 * shared horizon (@repo/db): wallet:adjust warns about automatic top-ups of the same span.
 */
export const ORPHAN_LOOKBACK_MS = AUTO_CREDIT_HORIZON_MS;
/** A failed job is retried again at most this often (its last failure alerted messageStuck). */
export const FAILED_RETRY_AFTER_MS = 30 * 60 * 1000;
/** At most this many orphans per sweep (one minute later the next ones). */
export const ORPHAN_BATCH = 100;

export interface OrphanRequeueResult {
  /** Messages without a job at all (lost enqueue, or the failed job aged out): added again. */
  readonly added: number;
  /** Failed jobs moved back to waiting with fresh attempts. */
  readonly retried: number;
}

/**
 * The fallback for a message that has no decision and no live job (S9 m1): the ingest commit
 * succeeded but the `bank-message` add after it did not, or the job failed every attempt and
 * fail-closed could not write the review. Every minute (from the topup-expire sweep) such a
 * message gets its job back under the same id `bm-<id>`: a missing job is added, a failed one is
 * retried with fresh attempts (not more often than FAILED_RETRY_AFTER_MS). A waiting, delayed or
 * active job is left alone; the matcher's outcome check makes any duplicate run a no-op, so the
 * money is still written once, by the matcher. Logs: counts only.
 */
@Injectable()
export class OrphanRequeueService {
  private readonly logger = new Logger(OrphanRequeueService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.BANK_MESSAGE) private readonly queue: Queue,
  ) {}

  async run(now: Date): Promise<OrphanRequeueResult> {
    const orphans = await this.prisma.client.bankMessage.findMany({
      where: {
        outcome: null,
        createdAt: {
          gte: new Date(now.getTime() - ORPHAN_LOOKBACK_MS),
          lt: new Date(now.getTime() - OUTCOME_SETTLE_MS),
        },
      },
      // Newest first: a message that fails for ever (alerted messageStuck, reported daily)
      // must not hold a fresh payment out of the batch.
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      take: ORPHAN_BATCH,
    });
    let added = 0;
    let retried = 0;
    for (const { id } of orphans) {
      const verdict = await this.requeue(id, now);
      if (verdict === 'ADDED') added += 1;
      if (verdict === 'RETRIED') retried += 1;
    }
    if (added > 0 || retried > 0) {
      this.logger.warn(`bank-message orphans added=${String(added)} retried=${String(retried)}`);
    }
    return { added, retried };
  }

  private async requeue(id: string, now: Date): Promise<'ADDED' | 'RETRIED' | 'LEFT'> {
    const jobId = bankMessageJobId(id);
    const job = await this.queue.getJob(jobId);
    if (job === undefined) {
      const data = bankMessageJobSchema.parse({ bankMessageId: id });
      await this.queue.add(BANK_MESSAGE_JOB_NAME, data, { jobId });
      return 'ADDED';
    }
    if ((await job.getState()) !== 'failed') return 'LEFT';
    const failedAt = job.finishedOn ?? 0;
    if (now.getTime() - failedAt < FAILED_RETRY_AFTER_MS) return 'LEFT';
    // Fresh wait counters too (B4): the failed job's data may hold used-up predecessorWaits /
    // dbOutageWaits, and a retry keeps the data it had.
    await job.updateData(bankMessageJobSchema.parse({ bankMessageId: id }));
    await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
    return 'RETRIED';
  }
}
