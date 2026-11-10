type Timer = 'lock' | 'poll' | 'watch';

/**
 * The listener's three interval timers (D-52): the lock tick, the poll round and the watchdog
 * (its own timer, r2 m1). Unref'd so they never keep the process alive. A fatal stop clears only
 * the poll and the watchdog: the lock timer stays to retry the `listenerStopped` alert.
 */
export class ListenerTimers {
  private readonly timers = new Map<Timer, NodeJS.Timeout>();

  every(name: Timer, ms: number, run: () => void): void {
    this.clear(name);
    const timer = setInterval(run, ms);
    timer.unref();
    this.timers.set(name, timer);
  }

  clear(...names: Timer[]): void {
    for (const name of names.length > 0 ? names : [...this.timers.keys()]) {
      const timer = this.timers.get(name);
      if (timer !== undefined) clearInterval(timer);
      this.timers.delete(name);
    }
  }
}
