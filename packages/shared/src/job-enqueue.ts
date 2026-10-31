// Pure enqueue decision for jobs that use `jobId = <entity id>` as their dedupe key
// (fulfill-order: jobId = orderId, .claude/rules/40-domain-money.md). Kept here, free of any
// bullmq import, so api and worker apply the very same rule and it is unit-testable.

/**
 * Job states BullMQ reports from `job.getState()`. `unknown` means the job does not exist.
 * Declared structurally (not imported from bullmq) so this package stays dependency-free.
 */
export const JOB_STATES = [
  'completed',
  'failed',
  'active',
  'delayed',
  'prioritized',
  'waiting',
  'waiting-children',
  'unknown',
] as const;
export type JobStateName = (typeof JOB_STATES)[number];

/**
 * - `add`:     no job with this id exists; add it.
 * - `replace`: a FINISHED job (completed/failed) still holds the id; BullMQ would silently drop
 *              a new `add()` with it, so remove it first and add again.
 * - `keep`:    a live job (queued, delayed, running, ...) already exists; the new request is a
 *              true duplicate and must not create or disturb anything.
 */
export type EnqueueAction = 'add' | 'replace' | 'keep';

/**
 * Why this exists: BullMQ ignores `add()` when the jobId is still present in ANY state, and
 * finished jobs are retained for days (QUEUE_JOB_DEFAULTS). A legitimate second enqueue —
 * HELD → QUEUED after a release, an admin retry after a failed job — would otherwise be lost
 * without an error and the order would sit in QUEUED forever.
 *
 * This only prevents LOST enqueues. The double-spend guard is NOT here: it is the order lock
 * plus the status re-check inside the processor (.claude/rules/45-fulfillment.md), so a
 * replaced job that runs again can never pay twice.
 *
 * `undefined` (job lookup returned nothing) behaves like `unknown`.
 */
export function decideEnqueue(state: JobStateName | undefined): EnqueueAction {
  switch (state) {
    case undefined:
    case 'unknown':
      return 'add';
    case 'completed':
    case 'failed':
      return 'replace';
    case 'active':
    case 'delayed':
    case 'prioritized':
    case 'waiting':
    case 'waiting-children':
      return 'keep';
  }
  // No default on purpose: the return type makes tsc reject a switch that forgets a state, so a
  // new BullMQ state cannot be added to JOB_STATES without being classified here.
}

/** Payload of a fulfill-order job. The id is also the jobId; the order row is the truth. */
export interface FulfillOrderJobData {
  readonly orderId: string;
}
