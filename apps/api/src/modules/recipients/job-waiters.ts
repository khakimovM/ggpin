/** How a wait for one job ended: its return value, or no usable answer (failed, gone, too late). */
export type JobOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

type Settle = (outcome: JobOutcome) => void;

/**
 * In-process registry of requests waiting for a job id. The client feeds it from ONE global
 * `completed` and ONE global `failed` listener on its QueueEvents, instead of BullMQ's
 * `job.waitUntilFinished`, which adds two listeners per wait (MaxListenersExceededWarning, with
 * the job id, from the 11th concurrent wait) and runs Redis calls inside `new Promise(async ...)`
 * whose rejections escape as unhandledRejection (a process exit on Node 24).
 *
 * Every waiter is called at most once; `add` returns its own removal, which the caller runs when
 * it settles by any other path (timer, direct state check).
 */
export class JobWaiters {
  private readonly waiting = new Map<string, Set<Settle>>();

  add(jobId: string, settle: Settle): () => void {
    let set = this.waiting.get(jobId);
    if (set === undefined) {
      set = new Set();
      this.waiting.set(jobId, set);
    }
    set.add(settle);
    return () => {
      const current = this.waiting.get(jobId);
      if (current === undefined) return;
      current.delete(settle);
      if (current.size === 0) this.waiting.delete(jobId);
    };
  }

  /** Settles every waiter of this job id (none: nothing happens) and forgets them. */
  settle(jobId: string, outcome: JobOutcome): void {
    const set = this.waiting.get(jobId);
    if (set === undefined) return;
    this.waiting.delete(jobId);
    for (const settle of set) settle(outcome);
  }

  /** Number of job ids someone waits for (tests, and a bound check in the client). */
  get size(): number {
    return this.waiting.size;
  }
}
