// In-process guard in front of the catalog API for the marketing pages (p8 S6 audit L-3).
//
// The Next.js data cache keeps only 200 answers, so with the API failing, or for a slug that does
// not exist, every page view was a new API request: a crawler or a script could turn page views
// into API load one to one. This memo:
//  - joins requests for the same key that are in flight at the same time (single-flight): ten
//    parallel views of a page are one API request;
//  - keeps a negative outcome for a short time (the caller decides which and how long), so a 404
//    or an outage is not asked again on every view;
//  - is bounded: at most `maxEntries` kept outcomes, the oldest goes first.
// It lives in the server process memory only (one per Node process), never in a shared store.

export class OutcomeMemo<T> {
  private readonly kept = new Map<string, { until: number; value: T }>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(
    private readonly maxEntries: number,
    /** How long to keep an outcome, in ms; 0 keeps nothing. */
    private readonly ttlOf: (value: T) => number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  run(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.kept.get(key);
    if (hit !== undefined) {
      if (hit.until > this.now()) return Promise.resolve(hit.value);
      this.kept.delete(key);
    }
    const pending = this.inFlight.get(key);
    // A rejection is a control-flow signal of the request that started the load (see read() in
    // catalog-server.ts), not an answer: a joined request then asks for itself.
    if (pending !== undefined) return pending.catch(() => load());

    const started = load().then((value) => {
      this.keep(key, value);
      return value;
    });
    this.inFlight.set(key, started);
    // Removed whichever way it ends; the `catch` only keeps this bookkeeping chain from reporting
    // an unhandled rejection (the caller still receives it through `started`).
    started.finally(() => this.inFlight.delete(key)).catch(() => undefined);
    return started;
  }

  clear(): void {
    this.kept.clear();
    this.inFlight.clear();
  }

  private keep(key: string, value: T): void {
    const ttl = this.ttlOf(value);
    if (ttl <= 0) return;
    this.kept.delete(key);
    while (this.kept.size >= this.maxEntries) {
      const oldest = this.kept.keys().next();
      if (oldest.done === true) break;
      this.kept.delete(oldest.value);
    }
    this.kept.set(key, { until: this.now() + ttl, value });
  }
}
