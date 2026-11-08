const HOUR_MS = 60 * 60 * 1000;

/** What `hit` says: log now (the first event of a new hour) and how many came in the last one. */
export interface HourlyHit {
  readonly logNow: boolean;
  /**
   * Events of the previous LOGGED hour: the last hour that had one, not necessarily the clock hour
   * before (0 for the first ever). Counted, not logged one by one.
   */
  readonly previousLoggedHourCount: number;
}

/**
 * Counts events per key and clock hour so a repeated security event is logged once an hour with
 * its count instead of once per message (S9 F-I1: a busy foreign chat must not flood the log,
 * and must not go quiet either). In memory: a worker restart starts a new count.
 */
export class HourlyCounter {
  private readonly hours = new Map<string, { hour: number; count: number }>();

  hit(key: string, now: Date): HourlyHit {
    const hour = Math.floor(now.getTime() / HOUR_MS);
    const seen = this.hours.get(key);
    if (seen !== undefined && seen.hour === hour) {
      seen.count += 1;
      return { logNow: false, previousLoggedHourCount: 0 };
    }
    this.hours.set(key, { hour, count: 1 });
    return { logNow: true, previousLoggedHourCount: seen?.count ?? 0 };
  }
}
