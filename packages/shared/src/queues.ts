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
 * unknown outcome into NEEDS_REVIEW instead of throwing — never a second payment. Completed
 * jobs are kept 7 days so a duplicate `jobId = orderId` enqueue in that window is a no-op;
 * the order state machine is the real guard after that.
 */
export const QUEUE_JOB_DEFAULTS: Readonly<Record<QueueName, QueueJobDefaults>> = {
  [QUEUES.FULFILL_ORDER]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 7 * DAY_SEC, count: 10_000 },
    removeOnFail: { age: 30 * DAY_SEC, count: 10_000 },
  },
  // The API waits ~10 s for the answer (phase 3), so only one quick retry fits in that window.
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
  // Telegram 429s are handled by the processor with `retry_after`; these attempts cover
  // transient network errors only.
  [QUEUES.TG_OUTBOX]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: DAY_SEC, count: 1_000 },
    removeOnFail: { age: 7 * DAY_SEC, count: 5_000 },
  },
};
