import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { QUEUES, RecipientCheckRequestSchema, type RecipientCheckResult } from '@repo/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import {
  RECIPIENT_CHECK_TIMING,
  VALIDATE_RECIPIENT_CONCURRENCY,
  VALIDATE_RECIPIENT_LIMITER,
  type RecipientCheckTiming,
} from './recipient-check.config';
import {
  RecipientLookupService,
  errorNameOf,
  type LookupOutcome,
} from './recipient-lookup.service';

type JobLike = Pick<Job, 'data' | 'timestamp'>;

const UNAVAILABLE: RecipientCheckResult = { status: 'UNAVAILABLE' };

/** The same worker error is logged again at most this often (a persistent fault stays visible). */
export const WORKER_ERROR_REPEAT_MS = 60_000;

/**
 * Consumer of `validate-recipient` (docs/06 S3b): the API's "who is this?" question, answered
 * while the API still waits (RECIPIENT_CHECK_TIMEOUT_MS from its add = `job.timestamp`).
 *
 * - An invalid request (payload or input that does not fit the product's form) is OUR bug, a
 *   producer/consumer mismatch, not an outage: `UnrecoverableError` (no retry; the API sees a
 *   failed job and answers 503), so it shows up as a failure instead of hiding as UNAVAILABLE.
 * - Everything else ends as a returned answer, never a throw: a throw would make BullMQ run the
 *   second attempt (queues.ts) after the API stopped waiting, a wasted provider request.
 * - Deadline: the lookup must end `replyMarginMs` before the API gives up; with less than
 *   `minCallMs` left the provider is not asked (a stale job, nobody waits for it): UNAVAILABLE.
 * - Logs: product id, adapter code, status, reason and duration only. Never the input, the
 *   display name, the providerRef or the job id (an unkeyed hash of a low-entropy username).
 * - Worker errors (a lost lock, a Redis fault) carry the job id in their message; BullMQ prints
 *   them with console.error when nobody listens, so `onWorkerError` listens and logs the error's
 *   class name only, once per change (and again at most every WORKER_ERROR_REPEAT_MS).
 */
@Processor(QUEUES.VALIDATE_RECIPIENT, {
  concurrency: VALIDATE_RECIPIENT_CONCURRENCY,
  limiter: VALIDATE_RECIPIENT_LIMITER,
})
export class ValidateRecipientProcessor extends WorkerHost {
  private readonly logger = new Logger(ValidateRecipientProcessor.name);
  private lastWorkerError: { readonly name: string; readonly at: number } | undefined;

  constructor(
    private readonly lookup: RecipientLookupService,
    @Inject(RECIPIENT_CHECK_TIMING) private readonly timing: RecipientCheckTiming,
  ) {
    super();
  }

  async process(job: JobLike): Promise<RecipientCheckResult> {
    const parsed = RecipientCheckRequestSchema.safeParse(job.data);
    if (!parsed.success) {
      const codes = [...new Set(parsed.error.issues.map((issue) => issue.code))].join(',');
      this.logger.error(`validate-recipient: invalid request (${codes}), not retried`);
      throw new UnrecoverableError('invalid validate-recipient request');
    }
    const { productId } = parsed.data;
    const started = Date.now();
    const { waitMs, replyMarginMs, minCallMs } = this.timing;
    // Capped from above too: a job timestamp in the future (clock skew) never holds a slot longer
    // than the API can wait.
    const budgetMs = Math.min(
      job.timestamp + waitMs - replyMarginMs - started,
      waitMs - replyMarginMs,
    );
    if (budgetMs < minCallMs) {
      this.logger.warn(`validate-recipient ${productId}: UNAVAILABLE (STALE), provider not asked`);
      return UNAVAILABLE;
    }

    let outcome: LookupOutcome;
    try {
      outcome = await this.lookup.check(parsed.data, budgetMs, minCallMs);
    } catch (error) {
      // check() never throws; this keeps the "no throw, no retry" rule if that ever changes.
      outcome = { kind: 'RESULT', result: UNAVAILABLE, reason: 'ERROR', adapter: null };
      this.logger.error(`validate-recipient ${productId}: lookup threw ${errorNameOf(error)}`);
    }
    const ms = String(Date.now() - started);
    if (outcome.kind === 'INVALID_INPUT') {
      const codes = [...new Set(outcome.issues)].join(',');
      this.logger.error(
        `validate-recipient ${productId}: input does not fit the product (${codes}), not retried`,
      );
      throw new UnrecoverableError('validate-recipient input does not fit the product');
    }
    const { result, reason, adapter } = outcome;
    const error = outcome.errorName === undefined ? '' : ` ${outcome.errorName}`;
    const line = `validate-recipient ${productId}: ${result.status} (${reason}${error}) adapter=${adapter ?? '-'} ${ms} ms`;
    if (reason === 'ANSWERED') this.logger.log(line);
    else this.logger.warn(line);
    return result;
  }

  @OnWorkerEvent('error')
  onWorkerError(error: unknown): void {
    const name = errorNameOf(error);
    const now = Date.now();
    const last = this.lastWorkerError;
    if (last?.name === name && now - last.at < WORKER_ERROR_REPEAT_MS) return;
    this.lastWorkerError = { name, at: now };
    this.logger.warn(`validate-recipient worker error: ${name}`);
  }
}
