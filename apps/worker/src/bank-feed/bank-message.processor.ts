import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { QUEUES, ResourceIdSchema } from '@repo/shared';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { z } from 'zod';
import { BankFeedNotifier } from './bank-feed-notifier';
import { isDbConnectionError } from './db-outage';
import { FailClosedService, type FailClosedResult } from './fail-closed.service';
import {
  BankMessageNotFoundError,
  MatcherService,
  PredecessorPendingError,
  type ProcessResult,
} from './matcher.service';

/** Waiting for an earlier message of the card: 20 delays of 30 s, about 10 minutes in all. */
export const PREDECESSOR_WAIT_MS = 30_000;
export const MAX_PREDECESSOR_WAITS = 20;
/**
 * The database is unreachable (S6 N5): 20 delays of 30 s, about 10 minutes, before the usual
 * attempts (and, after them, fail-closed) go on. A short outage then pauses no card.
 */
export const DB_OUTAGE_WAIT_MS = 30_000;
export const MAX_DB_OUTAGE_WAITS = 20;

/**
 * `bank-message` job payload: the stored row's id (never text or amounts), plus how many times
 * the job has already been delayed waiting for an earlier message of its card or for the
 * database to come back.
 */
export const bankMessageJobSchema = z.strictObject({
  bankMessageId: ResourceIdSchema,
  predecessorWaits: z.number().int().min(0).max(MAX_PREDECESSOR_WAITS).optional(),
  dbOutageWaits: z.number().int().min(0).max(MAX_DB_OUTAGE_WAITS).optional(),
});
export type BankMessageJob = z.infer<typeof bankMessageJobSchema>;

export type BankMessageJobResult = ProcessResult | 'FAILED_CLOSED';

type JobLike = Pick<Job, 'id' | 'data' | 'attemptsMade' | 'opts' | 'updateData' | 'moveToDelayed'>;

/**
 * Consumer of `bank-message` (jobId `bm-<id>`, 5 attempts, exponential 2 s; queues.ts).
 * Concurrency 1 keeps one worker's messages in order, but ordering is guaranteed by the
 * database, not the queue (docs/05 §6):
 * - an earlier unprocessed message of the card delays the job (`DelayedError`, which does NOT
 *   spend an attempt) up to MAX_PREDECESSOR_WAITS times; after that the matcher reviews it
 *   (CHAIN_BREAK / PREDECESSOR_PENDING) and pauses the card;
 * - an unreachable database (`isDbConnectionError`) delays the job the same way, up to
 *   MAX_DB_OUTAGE_WAITS times, before it spends attempts: a short outage pauses no card (N5);
 * - an unexpected error on the LAST attempt fails closed (FailClosedService: review, card
 *   paused, alert). When that cannot complete, the owner still gets `messageStuck` (ids only,
 *   no database write) and the job stays failed; the orphan re-queue retries it later. When the
 *   decision was already stored and only its post-commit effects failed, the alert is
 *   `effectsFailed` instead: the re-queue takes only undecided messages, so it is never re-run
 *   (S9F-I1). A money message never ends silently.
 * Logs carry the job id, the outcome and an error NAME only: never text, amounts or card digits.
 */
@Processor(QUEUES.BANK_MESSAGE, { concurrency: 1 })
export class BankMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(BankMessageProcessor.name);

  constructor(
    private readonly matcher: MatcherService,
    private readonly failClosed: FailClosedService,
    private readonly notifier: BankFeedNotifier,
  ) {
    super();
  }

  async process(job: JobLike, token?: string): Promise<BankMessageJobResult> {
    const parsed = bankMessageJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('invalid bank-message payload');
    const { bankMessageId } = parsed.data;
    const waits = parsed.data.predecessorWaits ?? 0;
    const dbWaits = parsed.data.dbOutageWaits ?? 0;
    // attemptsMade counts the attempts already finished, so this run is number attemptsMade + 1.
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    let failure: unknown;
    try {
      const result = await this.matcher.process(bankMessageId, waits >= MAX_PREDECESSOR_WAITS);
      this.logger.log(`bank-message job=${job.id ?? '?'} result=${result}`);
      return result;
    } catch (error) {
      if (error instanceof BankMessageNotFoundError) throw new UnrecoverableError(error.name);
      failure = error;
    }
    if (failure instanceof PredecessorPendingError) {
      // A Redis error here must not skip the last-attempt handling below (it becomes the failure).
      const next = { ...parsed.data, predecessorWaits: waits + 1 };
      failure = await this.delay(job, token, next, PREDECESSOR_WAIT_MS);
    } else if (isDbConnectionError(failure) && dbWaits < MAX_DB_OUTAGE_WAITS) {
      this.logger.warn(`bank-message job=${job.id ?? '?'} database unreachable, waiting`);
      const next = { ...parsed.data, dbOutageWaits: dbWaits + 1 };
      failure = await this.delay(job, token, next, DB_OUTAGE_WAIT_MS);
    }
    if (finalAttempt) return this.closeAfterLastFailure(job, bankMessageId, failure);
    throw failure;
  }

  /** Puts the job back to wait (not an attempt); returns the error when that itself failed. */
  private async delay(job: JobLike, token: string | undefined, data: BankMessageJob, ms: number) {
    try {
      await job.updateData(data);
      await job.moveToDelayed(Date.now() + ms, token);
    } catch (delayError) {
      return delayError;
    }
    throw new DelayedError();
  }

  private async closeAfterLastFailure(
    job: JobLike,
    id: string,
    cause: unknown,
  ): Promise<BankMessageJobResult> {
    const tag = `bank-message job=${job.id ?? '?'}`;
    const causeName = nameOf(cause);
    let result: FailClosedResult;
    try {
      result = await this.failClosed.close(id);
    } catch (closeError) {
      // Only the stuck path can throw here (its own alert): nothing is decided, re-queued later.
      this.logger.error(
        `${tag} fail-closed did not complete (${nameOf(closeError)}) after: ${causeName}`,
      );
      await this.alertQuietly(tag, 'messageStuck', id);
      throw cause;
    }
    if (result === 'FAILED_CLOSED') {
      this.logger.error(`${tag} failed closed (review written) after: ${causeName}`);
      return 'FAILED_CLOSED';
    }
    if (result === 'STUCK_ALERTED') {
      this.logger.error(`${tag} review could not be written, owner alerted, after: ${causeName}`);
    } else {
      // The decision is stored; what failed came after the commit (its effects). The orphan
      // re-queue never takes a decided message, so the owner is told it will not re-run.
      this.logger.error(`${tag} decision stored, post-commit effects failed: ${causeName}`);
      await this.alertQuietly(tag, 'effectsFailed', id);
    }
    throw cause;
  }

  /** Last resort: ids only, no database; its own failure is logged, the job fails anyway. */
  private async alertQuietly(
    tag: string,
    alert: 'messageStuck' | 'effectsFailed',
    id: string,
  ): Promise<void> {
    try {
      await this.notifier.alert(alert, id);
    } catch (alertError) {
      this.logger.error(`${tag} owner alert failed too: ${nameOf(alertError)}`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Pick<Job, 'id' | 'attemptsMade'> | undefined, error: Error): void {
    this.logger.warn(
      `bank-message job=${job?.id ?? '?'} attempt=${String(job?.attemptsMade ?? 0)} failed: ${error.name}`,
    );
  }
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
