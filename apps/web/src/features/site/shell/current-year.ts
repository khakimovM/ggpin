import { DISPLAY_TIME_ZONE } from '../../../lib/format/date';

/**
 * The year in Uzbekistan time, like every other date of the app: around New Year the footer must
 * not say 2025 for the people it is written for while Tashkent is already in 2026.
 */
export function yearInDisplayZone(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: DISPLAY_TIME_ZONE }).format(
    now,
  );
}
