import { AppError } from '../exceptions/app-error';

// The server deadline of an admin write (docs/04 «So‘rov deadline’i», 9-B M-1, owner decision
// 2026-11-23 Q3). The panel gives up on a keyed write after 30 s and then asks the server what
// happened; a write that is still running long after that must not commit behind its back. So an
// admin write is checked against the time it was received at three points (after the replay
// lookup, at the start of its transaction, right before the commit) and refused with nothing
// written once 45 s have passed: the key stays free and a resend with it is safe.

/** A server constant, deliberately not an env (Q3). */
export const ADMIN_WRITE_DEADLINE_MS = 45_000;

/**
 * Milliseconds on a monotonic clock. Never the wall clock: it steps (NTP, the WSL VM), and a step
 * back would stretch the deadline, a step forward would refuse writes at random.
 */
export interface MonotonicClock {
  nowMs(): number;
}

/** The Nest token of the clock the deadline checks read; tests replace it to move time. */
export const MONOTONIC_CLOCK = Symbol('MONOTONIC_CLOCK');

/** `performance.now()`: the same source the onRequest hook stamps the request with. */
export const performanceClock: MonotonicClock = { nowMs: () => performance.now() };

/** When the request was received (the onRequest stamp) and the clock to measure it against. */
export interface AdminDeadline {
  readonly receivedAtMs: number;
  readonly clock: MonotonicClock;
}

/**
 * Refuses with `503 ADMIN_DEADLINE_EXCEEDED` once more than ADMIN_WRITE_DEADLINE_MS have passed
 * since the request was received. Exactly the deadline still passes. A stamp or reading that is
 * not a finite number refuses too (fail closed: a missing stamp must never mean "no deadline").
 */
export function assertWithinDeadline(deadline: AdminDeadline): void {
  const elapsedMs = deadline.clock.nowMs() - deadline.receivedAtMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs > ADMIN_WRITE_DEADLINE_MS) {
    throw new AppError('ADMIN_DEADLINE_EXCEEDED');
  }
}
