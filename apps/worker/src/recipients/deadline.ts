/** What `Deadline.race` gives when the time ran out before the work settled. */
export const TIMED_OUT = Symbol('TIMED_OUT');

/** The reason `Deadline.signal` aborts with (a fixed message: never a value). */
export class DeadlineAbortError extends Error {
  constructor() {
    super('the caller stopped waiting');
    this.name = 'DeadlineAbortError';
  }
}

/**
 * One time budget shared by several awaited steps (product read, route pick, provider call).
 * A step that loses the race is not awaited any more (Promise.race has subscribed to it, so a late
 * rejection is never unhandled). The provider call is ALSO told (S7, S3b gate I-1): `signal`
 * aborts when the budget runs out, and when the deadline is disposed, so an adapter that honours
 * it (the interface demands it) stops instead of running on in the background. Always
 * `dispose()` it so the timer does not outlive the run.
 */
export class Deadline {
  private timer: NodeJS.Timeout | undefined;
  private readonly expired: Promise<typeof TIMED_OUT>;
  private readonly endsAt: number;
  private readonly controller = new AbortController();
  private ranOut = false;

  constructor(budgetMs: number) {
    const budget = Math.max(0, budgetMs);
    this.endsAt = Date.now() + budget;
    this.expired = new Promise((resolve) => {
      this.timer = setTimeout(() => {
        this.ranOut = true;
        resolve(TIMED_OUT);
        this.controller.abort(new DeadlineAbortError());
      }, budget);
    });
  }

  /** Aborts when the budget is spent or the deadline is disposed. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  race<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
    return Promise.race([work, this.expired]);
  }

  /**
   * True once the budget ran out. An adapter that honours the signal answers at once when it
   * aborts (e.g. UNAVAILABLE), and that answer can win the race against TIMED_OUT: it is still a
   * timeout, not the provider's answer.
   */
  get timedOut(): boolean {
    return this.ranOut;
  }

  /** Milliseconds left (0 once over). */
  remainingMs(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.controller.signal.aborted) this.controller.abort(new DeadlineAbortError());
  }
}
