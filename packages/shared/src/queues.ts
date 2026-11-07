// BullMQ queue names, docs/02-ARCHITECTURE.md "Navbatlar". A typo in a queue name silently
// strands jobs, so producers (api) and consumers (worker) both import these.
export const QUEUES = {
  FULFILL_ORDER: 'fulfill-order',
  VALIDATE_RECIPIENT: 'validate-recipient',
  PRICE_SYNC: 'price-sync',
  FRAGMENT_KEEPALIVE: 'fragment-keepalive',
  RECONCILE: 'reconcile',
  TG_OUTBOX: 'tg-outbox',
  PAYMENT_RECONCILE: 'payment-reconcile',
  BANK_MESSAGE: 'bank-message',
  CARD_LIMIT: 'card-limit',
  TOPUP_EXPIRE: 'topup-expire',
  NOTIFY: 'notify',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUES);

// Structurally a subset of BullMQ's DefaultJobOptions, kept here (not in bullmq types) so this
// package stays dependency-free and both apps apply the very same values: default job options
// are applied by whichever side calls `queue.add`, and both api and worker add jobs.
export interface QueueJobDefaults {
  readonly attempts: number;
  readonly backoff: { readonly type: 'exponential'; readonly delay: number };
  // Bounded retention: unbounded completed/failed sets grow Redis memory without limit.
  readonly removeOnComplete: { readonly age: number; readonly count: number };
  readonly removeOnFail: { readonly age: number; readonly count: number };
}

const HOUR_SEC = 60 * 60;
const DAY_SEC = 24 * HOUR_SEC;

/**
 * How long a finished `notify` job is kept, and so how long its job id (`topup-<paymentId>`,
 * `alert-<kind>-<refId>`) deduplicates a repeated add. The worker re-derives notifications from
 * a stored outcome on every replay; it adds them only while the outcome is younger than this
 * (BankFeedEffects), so a replay can never tell a user or the owner the same thing twice.
 * The jobs carry ids only (notify.ts), so keeping them long holds no amounts or text in Redis.
 */
export const NOTIFY_DEDUPE_SEC = 30 * DAY_SEC;

// Cron-driven jobs: the next tick is the retry, so a failure is not re-run on its own.
const CRON_DEFAULTS: QueueJobDefaults = {
  attempts: 1,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: { age: DAY_SEC, count: 100 },
  removeOnFail: { age: 7 * DAY_SEC, count: 500 },
};

/**
 * Per-queue defaults (docs/02-ARCHITECTURE.md "Navbatlar"; delays in ms, ages in seconds).
 *
 * fulfill-order: 5 attempts, 5 s base (5/10/20/40 s). A retry is only safe because the
 * processor (phase 5) reconciles any existing FulfillmentAttempt before sending and turns an
 * unknown outcome into NEEDS_REVIEW instead of throwing — never a second payment.
 *
 * Enqueue with `jobId = orderId` ONLY through the shared enqueue path (`decideEnqueue` in
 * job-enqueue.ts, used by the API's FulfillOrderEnqueuer): BullMQ drops an `add()` whose id still
 * exists in any state, and finished jobs are retained 7 days (completed) / 30 days (failed), so a
 * plain `queue.add` would lose a legitimate second enqueue (HELD → QUEUED, admin retry). The
 * order lock and status re-check in the processor are the real double-spend guard.
 */
export const QUEUE_JOB_DEFAULTS: Readonly<Record<QueueName, QueueJobDefaults>> = {
  [QUEUES.FULFILL_ORDER]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 7 * DAY_SEC, count: 10_000 },
    removeOnFail: { age: 30 * DAY_SEC, count: 10_000 },
  },
  // The API waits ~10 s for the answer (phase 5), so only one quick retry fits in that window.
  [QUEUES.VALIDATE_RECIPIENT]: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: { age: HOUR_SEC, count: 1_000 },
    removeOnFail: { age: DAY_SEC, count: 1_000 },
  },
  [QUEUES.PRICE_SYNC]: CRON_DEFAULTS,
  [QUEUES.FRAGMENT_KEEPALIVE]: CRON_DEFAULTS,
  [QUEUES.RECONCILE]: CRON_DEFAULTS,
  [QUEUES.PAYMENT_RECONCILE]: CRON_DEFAULTS,
  [QUEUES.TOPUP_EXPIRE]: CRON_DEFAULTS,
  // One job per stored bank message (jobId `bm-<id>`), consumed by the worker with
  // concurrency 1 so the balance chain is checked in message order. A retry is safe: the
  // processor first looks for the message's BankMessageOutcome and does nothing if it exists.
  // Failed jobs are kept longest: a stuck message is a possibly unpaid customer.
  [QUEUES.BANK_MESSAGE]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3 * DAY_SEC, count: 10_000 },
    removeOnFail: { age: 30 * DAY_SEC, count: 10_000 },
  },
  // One job per received CREDIT on a card (jobId `cl-<bankMessageId>`), added after the message's
  // decision committed: the card-limit check (80 % / FULL, docs/05 §2) under the card lock. Its
  // own attempts, so a busy card (55P03) never costs the message's alerts or attempts; after the
  // last one the owner gets `limitCheckFailed`. Re-running it is safe (FULL is a state, the
  // alert ids are stable).
  [QUEUES.CARD_LIMIT]: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3 * DAY_SEC, count: 10_000 },
    removeOnFail: { age: 30 * DAY_SEC, count: 10_000 },
  },
  // Worker -> api: "tell this user / the owner something happened" (notify.ts). The api renders
  // the text and hands it to tg-outbox, so the worker never holds the bot token. Completed jobs
  // stay NOTIFY_DEDUPE_SEC (ids only) with a count far above the expected volume, so the age,
  // not the count, decides when an id stops deduplicating.
  [QUEUES.NOTIFY]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: NOTIFY_DEDUPE_SEC, count: 200_000 },
    removeOnFail: { age: 7 * DAY_SEC, count: 5_000 },
  },
  // Telegram 429s are handled by the processor with `retry_after`; these attempts cover
  // transient network errors only. Kept short on purpose, completed AND failed: these jobs hold
  // the rendered text (amounts, balances) and the chat id. Deduplication of top-up and alert messages is the notify job's
  // (NOTIFY_DEDUPE_SEC); the outbox id equals the notify id only as a second line.
  [QUEUES.TG_OUTBOX]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: DAY_SEC, count: 1_000 },
    // Failed ones too (a 403 / 400 keeps the text and the chat id): one day, not a week (N4).
    removeOnFail: { age: DAY_SEC, count: 5_000 },
  },
};
