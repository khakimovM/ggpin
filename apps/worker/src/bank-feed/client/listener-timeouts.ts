/** A call that did not settle in time (a hung Redis or Telegram call, D-52 r2 review m1). */
export class ListenerTimeoutError extends Error {
  constructor(readonly what: string) {
    super(`${what} timed out`);
    this.name = 'ListenerTimeoutError';
  }
}

/** Default bounds of the listener's calls that must never hold up its timers. */
export const LISTENER_TIMEOUTS = {
  /** client.stop(): mtcute's stopUpdatesLoop + disconnect. */
  stopMs: 10_000,
  /** One owner alert (`queue.add`): BullMQ waits forever without Redis (maxRetriesPerRequest: null). */
  alertMs: 5_000,
  /** Heartbeat clear and lock release while disconnecting. */
  redisMs: 5_000,
} as const;

export type ListenerTimeouts = { readonly [K in keyof typeof LISTENER_TIMEOUTS]: number };

/**
 * `task`, or a ListenerTimeoutError after `ms`. The task itself is not cancelled (JS cannot):
 * it may still settle later, and its late rejection is swallowed here so it never surfaces as an
 * unhandled rejection.
 */
export function withTimeout<T>(task: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ListenerTimeoutError(what)), ms);
    timer.unref();
  });
  task.catch(() => undefined);
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}
