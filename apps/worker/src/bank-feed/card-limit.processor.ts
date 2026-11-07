import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { QUEUES } from '@repo/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { CardLimitCheck, type CardLimitResult } from './card-limit-check';
import { cardLimitJobSchema } from './card-limit-scheduler';

/**
 * Consumer of `card-limit` (jobId `cl-<bankMessageId>`, 8 attempts, exponential 2 s; queues.ts).
 * A busy card (55P03 under BANK_FEED_LOCK_TIMEOUT_MS) or any other error retries with the
 * queue's backoff; when the LAST attempt fails too, the owner gets `limitCheckFailed` before the
 * job is left failed. Logs carry the job id, the result and an error NAME only.
 */
@Processor(QUEUES.CARD_LIMIT, { concurrency: 1 })
export class CardLimitProcessor extends WorkerHost {
  private readonly logger = new Logger(CardLimitProcessor.name);

  constructor(private readonly check: CardLimitCheck) {
    super();
  }

  async process(job: Pick<Job, 'id' | 'data' | 'attemptsMade' | 'opts'>): Promise<CardLimitResult> {
    const parsed = cardLimitJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('invalid card-limit payload');
    const { bankMessageId } = parsed.data;
    try {
      const result = await this.check.run(bankMessageId);
      this.logger.log(`card-limit job=${job.id ?? '?'} result=${result}`);
      return result;
    } catch (error) {
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        const name = error instanceof Error ? error.name : 'unknown';
        this.logger.error(`card-limit job=${job.id ?? '?'} gave up after: ${name}`);
        await this.check.giveUp(bankMessageId);
      }
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Pick<Job, 'id' | 'attemptsMade'> | undefined, error: Error): void {
    this.logger.warn(
      `card-limit job=${job?.id ?? '?'} attempt=${String(job?.attemptsMade ?? 0)} failed: ${error.name}`,
    );
  }
}
