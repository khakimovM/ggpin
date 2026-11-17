import { TASHKENT_UTC_OFFSET_MINUTES, type AdminDashboardQuery } from '@repo/shared';

const OFFSET_MS = TASHKENT_UTC_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;
/** Calendar days a preset period covers, today included. */
const PRESET_DAYS = { today: 1, week: 7, month: 30 } as const;

export interface DashboardPeriod {
  /** Inclusive start. */
  readonly from: Date;
  /** Exclusive end. */
  readonly to: Date;
}

/** Midnight (Asia/Tashkent, UTC+5 all year) of the day `instant` falls on, as a UTC instant. */
export function tashkentDayStart(instant: Date): Date {
  const local = instant.getTime() + OFFSET_MS;
  return new Date(local - (((local % DAY_MS) + DAY_MS) % DAY_MS) - OFFSET_MS);
}

/** `YYYY-MM-DD` of the Tashkent day `instant` falls on (the chart's `day`). */
export function tashkentDay(instant: Date): string {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The window a dashboard query asks about. The presets are whole Tashkent calendar days ending
 * now: `today` from today's midnight, `week` the last 7 days and `month` the last 30, today
 * included (so a chart has no half day at its start). `range` is the caller's own instants.
 */
export function dashboardPeriod(query: AdminDashboardQuery, now: Date): DashboardPeriod {
  if (query.period === 'range' && query.from !== undefined && query.to !== undefined) {
    return { from: new Date(query.from), to: new Date(query.to) };
  }
  const days = query.period === 'range' ? 1 : PRESET_DAYS[query.period];
  const from = new Date(tashkentDayStart(now).getTime() - (days - 1) * DAY_MS);
  return { from, to: now };
}

/** Every Tashkent day the period touches, oldest first (empty days still get a chart point). */
export function periodDays(period: DashboardPeriod): string[] {
  const days: string[] = [];
  const last = new Date(Math.max(period.from.getTime(), period.to.getTime() - 1));
  for (
    let day = tashkentDayStart(period.from);
    day <= last;
    day = new Date(day.getTime() + DAY_MS)
  ) {
    days.push(tashkentDay(day));
  }
  return days;
}
