import type { AdminDeadline, MonotonicClock } from '../admin-deadline';

/** A monotonic clock a test sets by hand (docs/04 «So‘rov deadline’i»: never the wall clock). */
export class FakeMonotonicClock implements MonotonicClock {
  constructor(public ms = 0) {}

  nowMs(): number {
    return this.ms;
  }
}

/** A deadline that never runs out in a unit test (received now, the clock never moves). */
export const OPEN_DEADLINE: AdminDeadline = { receivedAtMs: 0, clock: new FakeMonotonicClock(0) };
