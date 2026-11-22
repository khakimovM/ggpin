import { TASHKENT_UTC_OFFSET_MINUTES } from '@repo/shared';

// The date filter of the admin lists: a few presets measured in Tashkent calendar days (the day
// the operator sees), sent to the API as `from` (inclusive, ISO UTC). "all" sends nothing.

export const DATE_PRESETS = ['all', 'today', 'week', 'month'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

const DAY_MS = 86_400_000;
const OFFSET_MS = TASHKENT_UTC_OFFSET_MINUTES * 60_000;

/** Midnight in Tashkent of the day `now` falls on, as a UTC instant. */
export function tashkentDayStart(now: Date): Date {
  const local = now.getTime() + OFFSET_MS;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - OFFSET_MS);
}

const DAYS_BACK: Record<Exclude<DatePreset, 'all'>, number> = { today: 0, week: 6, month: 29 };

/** `from` of a preset: today = since midnight; week / month = 7 / 30 days including today. */
export function fromOfPreset(preset: string, now: Date): string | undefined {
  if (preset !== 'today' && preset !== 'week' && preset !== 'month') return undefined;
  const start = tashkentDayStart(now).getTime() - DAYS_BACK[preset] * DAY_MS;
  return new Date(start).toISOString();
}
