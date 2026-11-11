/**
 * `work`, or a rejection after `ms`. Redis reads on the request path use it: ioredis queues
 * commands while it reconnects, and a request must not hang on a cache or a heartbeat. The
 * late result of `work` is swallowed so it never becomes an unhandled rejection.
 */
export async function withinMs<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} did not answer within ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
