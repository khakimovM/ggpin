import { createHash } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  QUEUES,
  RECIPIENT_CHECK_JOB_NAME,
  RECIPIENT_CHECK_REUSE_MS,
  RecipientCheckResultSchema,
  scrubSecretsInText,
  type RecipientCheckRequest,
  type RecipientCheckResult,
} from '@repo/shared';
import { QueueEvents, type Queue } from 'bullmq';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppError } from '../../common/exceptions/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { JobWaiters, type JobOutcome } from './job-waiters';

/** How long to wait for the worker's answer; RECIPIENT_CHECK_TIMEOUT_MS, shorter in e2e. */
export const RECIPIENT_CHECK_WAIT_MS = Symbol('RECIPIENT_CHECK_WAIT_MS');

/**
 * Job id of a question: SHA-256 over the product, the NORMALIZED input (sorted keys) and the
 * RECIPIENT_CHECK_REUSE_MS bucket of `now`. Identical questions inside one bucket share a job
 * (BullMQ ignores an add whose id exists) and so one provider lookup; the next bucket is a new
 * id, so an answer is never used once its bucket is over. Hex digest with a prefix: BullMQ
 * refuses custom ids with `:` and integer-like ids. The id is a hash of personal data and is
 * never logged.
 */
export function recipientCheckJobId(request: RecipientCheckRequest, now: Date): string {
  const bucket = Math.floor(now.getTime() / RECIPIENT_CHECK_REUSE_MS);
  const input = Object.keys(request.input)
    .sort()
    .map((key) => [key, request.input[key]]);
  const canonical = JSON.stringify([request.productId, input, bucket]);
  return `vr-${createHash('sha256').update(canonical).digest('hex')}`;
}

const unavailable = (): AppError => new AppError('RECIPIENT_CHECK_UNAVAILABLE');
const NO_ANSWER: JobOutcome = { ok: false };

/**
 * How long shutdown waits for the events connection to close. A healthy close takes
 * milliseconds; one that never connected never resolves (BullMQ awaits the first connect). 2 s
 * keeps it well inside the container's stop grace period (docker: 10 s) with room for the other
 * shutdown hooks (queues, Prisma, HTTP drain), and is far above a healthy close.
 */
export const EVENTS_CLOSE_TIMEOUT_MS = 2_000;

// The event loop must not be held open by a timer whose only job is to give up.
function delay(ms: number): { readonly done: Promise<void>; readonly cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  return { done, cancel: () => clearTimeout(timer) };
}

// Never the value: an ioredis error can quote the connection URL. An AggregateError (Node's
// multi-address connect, e.g. ECONNREFUSED on ::1 and 127.0.0.1) has an empty message, so it
// is described by its code or, failing that, its class name.
function describeError(error: Error): string {
  if (error.message !== '') return scrubSecretsInText(error.message);
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : error.name;
}

/**
 * Asks the worker (the only process that may reach Fragment or a supplier) who a recipient is,
 * over the `validate-recipient` queue, and waits for the answer. Every way of not getting a
 * usable answer in time (Redis refused the job, no worker, a slow worker, a failed job, an answer
 * that does not parse) is `503 RECIPIENT_CHECK_UNAVAILABLE`: never "not found", so an outage can
 * never look like a missing user, and never a token for an unchecked recipient.
 *
 * Reuse: FOUND and NOT_FOUND stay on the job for the rest of its 60 s bucket. A job without such
 * an answer (no answer, failed, malformed, or UNAVAILABLE) is removed when no worker holds it, so
 * the next request asks again instead of reusing an outage (the worker's limiter protects the
 * provider) and jobs do not pile up while no worker runs.
 *
 * Waiting does not use BullMQ's `job.waitUntilFinished` (see JobWaiters): one global listener
 * pair, and every Redis call of a wait is awaited inside a try/catch, so nothing can surface as
 * an unhandled rejection. Log lines carry fixed text only: no job id, input, name or handle.
 */
@Injectable()
export class RecipientCheckClient implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger('RecipientCheck');
  private readonly waiters = new JobWaiters();
  private events: QueueEvents | undefined;
  private lastError: string | undefined;
  private closing = false;

  constructor(
    @InjectQueue(QUEUES.VALIDATE_RECIPIENT) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RECIPIENT_CHECK_WAIT_MS) private readonly waitMs: number,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // Its own blocking connection (XREAD on the events stream), opened at boot so the first
  // request does not pay for it. Offline queue on: it reconnects by itself after a Redis outage.
  onModuleInit(): void {
    const events = new QueueEvents(QUEUES.VALIDATE_RECIPIENT, {
      connection: { url: this.config.REDIS_URL, maxRetriesPerRequest: null },
    });
    events.on('completed', ({ jobId, returnvalue }: { jobId: string; returnvalue: unknown }) => {
      this.waiters.settle(jobId, { ok: true, value: returnvalue });
    });
    events.on('failed', ({ jobId }: { jobId: string }) => {
      this.waiters.settle(jobId, NO_ANSWER);
    });
    events.on('error', (error: Error) => {
      const message = describeError(error);
      if (message === this.lastError) return;
      this.lastError = message;
      this.logger.warn(`queue events error: ${message}`);
    });
    this.events = events;
  }

  /**
   * Every request still waiting answers 503 at once instead of holding the shutdown for its
   * full wait, and new ones answer 503 without enqueueing. The events connection gets
   * EVENTS_CLOSE_TIMEOUT_MS to close; one that hangs (Redis never reached) is left behind with a
   * warning, so the rest of the shutdown runs.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;
    const events = this.events;
    this.events = undefined;
    this.waiters.settleAll(NO_ANSWER);
    if (events === undefined) return;
    const timeout = delay(EVENTS_CLOSE_TIMEOUT_MS);
    const closed = await Promise.race([
      events.close().then(
        () => true,
        () => true,
      ),
      timeout.done.then(() => false),
    ]);
    timeout.cancel();
    if (!closed) this.logger.warn('queue events connection did not close in time');
  }

  async check(request: RecipientCheckRequest): Promise<RecipientCheckResult> {
    const events = this.events;
    if (events === undefined) throw unavailable();
    const jobId = recipientCheckJobId(request, this.clock.now());

    try {
      await this.queue.add(RECIPIENT_CHECK_JOB_NAME, request, { jobId });
    } catch {
      this.logger.warn('recipient check not enqueued (redis unavailable)');
      throw unavailable();
    }

    // An await above may have let shutdown start: its settleAll ran before this wait existed.
    const outcome = this.closing ? NO_ANSWER : await this.waitFor(events, jobId);
    if (!outcome.ok) {
      this.logger.warn('recipient check gave no answer in time');
      await this.discard(jobId);
      throw unavailable();
    }
    const parsed = RecipientCheckResultSchema.safeParse(outcome.value);
    if (!parsed.success) {
      this.logger.warn('recipient check answer is malformed');
      await this.discard(jobId);
      throw unavailable();
    }
    // An outage is not an answer worth reusing: the next request asks again.
    if (parsed.data.status === 'UNAVAILABLE') await this.discard(jobId);
    return parsed.data;
  }

  /**
   * Resolves (never rejects) with the job's outcome: the waiter and the timer are registered
   * first, then the job's current state is read, which catches a job that finished before the
   * waiter existed (an identical question earlier in the bucket). Whichever comes first wins; the
   * timer and the waiter are always cleared.
   */
  private waitFor(events: QueueEvents, jobId: string): Promise<JobOutcome> {
    return new Promise<JobOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: JobOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unregister();
        resolve(outcome);
      };
      const unregister = this.waiters.add(jobId, finish);
      const timer = setTimeout(() => finish(NO_ANSWER), this.waitMs);
      void this.currentOutcome(events, jobId).then((outcome) => {
        if (outcome !== null) finish(outcome);
      });
    });
  }

  // Null while the job is still waiting or running (the listeners will tell). Never rejects: a
  // Redis error here is "no usable answer", answered as 503 by the caller.
  private async currentOutcome(events: QueueEvents, jobId: string): Promise<JobOutcome | null> {
    try {
      // The events connection must be up before the state is read, or an event that lands in
      // between would surely be missed. Ready means connected, not yet reading: on an empty
      // stream the reader starts at `$` one round trip later, and an event in that gap is
      // missed too; the wait then ends by its timer (503), never with a wrong answer.
      await events.waitUntilReady();
      // State first, data second: `completed` is final, so the job read after it holds the
      // answer. (Read the other way round, a job that completes between the two calls would be
      // seen as completed with the empty return value it had while running.)
      const state = await this.queue.getJobState(jobId);
      if (state === 'completed') {
        const job = await this.queue.getJob(jobId);
        return job === undefined ? NO_ANSWER : { ok: true, value: job.returnvalue };
      }
      if (state === 'failed' || state === 'unknown') return NO_ANSWER;
      return null;
    } catch {
      return NO_ANSWER;
    }
  }

  // Removes a waiting, delayed, failed, malformed or UNAVAILABLE job. A job a worker is
  // processing is locked and stays (remove answers 0); best effort: the caller already knows
  // what to answer either way.
  //
  // Not while another request in THIS process still waits for the same id (it joined later and
  // its own wait runs on): the last one to leave removes it. A waiter in another API process is
  // not seen, and its job can still be removed under it; it then answers 503 by its own timer.
  // The same holds for a request of this process that joins after the check below: the removal
  // already under way takes the job, and the newcomer answers 503 (fail closed, never a token).
  private async discard(jobId: string): Promise<void> {
    if (this.waiters.has(jobId)) return;
    try {
      await this.queue.remove(jobId);
    } catch {
      this.logger.warn('recipient check job not removed');
    }
  }
}
