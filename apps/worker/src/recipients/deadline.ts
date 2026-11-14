/** What `Deadline.race` gives when the time ran out before the work settled. */
export const TIMED_OUT = Symbol('TIMED_OUT');

/**
 * One time budget shared by several awaited steps (product read, route pick, provider call).
 * A step that loses the race is NOT cancelled: it keeps running in the background and its later
 * result or rejection is ignored (Promise.race has subscribed to it, so a late rejection is never
 * unhandled). So the deadline frees the job SLOT, not the provider request: a real adapter needs
 * its own hard timeout and an AbortSignal (S7/S8). Always `dispose()` it so the timer does not
 * outlive the run.
 */
export class Deadline {
  private timer: NodeJS.Timeout | undefined;
  private readonly expired: Promise<typeof TIMED_OUT>;
  private readonly endsAt: number;

  constructor(budgetMs: number) {
    const budget = Math.max(0, budgetMs);
    this.endsAt = Date.now() + budget;
    this.expired = new Promise((resolve) => {
      this.timer = setTimeout(() => resolve(TIMED_OUT), budget);
    });
  }

  race<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
    return Promise.race([work, this.expired]);
  }

  /** Milliseconds left (0 once over). */
  remainingMs(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
