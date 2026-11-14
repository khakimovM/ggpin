import type { Locale } from '@repo/shared';

// Pure date helpers (no React): the locale and time zone are arguments, so a test can pin both.
// Russian month names come from Intl ("15 ноября"). Uzbek ones are a table below: Chromium's ICU
// has no Uzbek calendar data and answers "M11 15" (seen in Playwright's Chromium 156), so Intl
// cannot be trusted for "uz" in a browser.

/**
 * Every date is shown in Uzbekistan time, whatever the device says. Bank notifications, which
 * payments are matched against, carry Tashkent time, so a user comparing a bank message with our
 * screen sees the same clock. It also makes server and client render the same text, so there is
 * no hydration mismatch.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Tashkent';

export interface DateFormatOptions {
  locale: Locale;
  /** IANA zone; Tashkent when omitted (tests pin it explicitly). */
  timeZone?: string;
}

export interface RelativeLabels {
  today: string;
  yesterday: string;
}

export function formatTime(
  date: Date,
  { locale, timeZone = DISPLAY_TIME_ZONE }: DateFormatOptions,
): string {
  // h23 keeps "00:05" at midnight (Intl otherwise answers "24:05" in some locales).
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(date);
}

// Month names of the Uzbek (Latin) calendar, lower case, no apostrophes.
const UZ_MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
] as const;

/** "15-noyabr" (+ ", 2025" outside the current year), the Uzbek way, whatever the engine knows. */
function formatUzDay(date: Date, timeZone: string, withYear: boolean): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(date);
  const [year, month, day] = parts.split('-').map(Number);
  const name = UZ_MONTHS[(month ?? 1) - 1] ?? '';
  return withYear ? `${day}-${name}, ${year}` : `${day}-${name}`;
}

/** "15-noyabr" / "15 ноября"; the year is added when it is not `now`'s year. */
export function formatDay(date: Date, options: DateFormatOptions, now: Date = new Date()): string {
  const { locale, timeZone = DISPLAY_TIME_ZONE } = options;
  const sameYear = yearOf(date, timeZone) === yearOf(now, timeZone);
  if (locale === 'uz') return formatUzDay(date, timeZone, !sameYear);
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
    timeZone,
  }).format(date);
}

/** "15-noyabr, 2026" / "15 ноября 2026 г.": with the year always (the date of a document). */
export function formatFullDay(date: Date, options: DateFormatOptions): string {
  const { locale, timeZone = DISPLAY_TIME_ZONE } = options;
  if (locale === 'uz') return formatUzDay(date, timeZone, true);
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(date);
}

/** "15-noyabr, 14:05" / "15 ноября, 14:05"; the year is added when it is not `now`'s year. */
export function formatDateTime(
  date: Date,
  options: DateFormatOptions,
  now: Date = new Date(),
): string {
  return `${formatDay(date, options, now)}, ${formatTime(date, options)}`;
}

function yearOf(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(date);
}

// Calendar day number in the target zone, so "yesterday" follows local midnight.
function dayNumber(date: Date, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(date);
  const [year, month, day] = parts.split('-').map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / 86_400_000;
}

/**
 * "Bugun, 14:05" / "Kecha, 14:05" for the last two calendar days, else `formatDateTime`.
 * The words come from i18n (`common.today`, `common.yesterday`) through `labels`.
 */
export function formatUserDateTime(
  date: Date,
  options: DateFormatOptions & { labels: RelativeLabels },
  now: Date = new Date(),
): string {
  const timeZone = options.timeZone ?? DISPLAY_TIME_ZONE;
  const daysAgo = dayNumber(now, timeZone) - dayNumber(date, timeZone);
  if (daysAgo === 0) return `${options.labels.today}, ${formatTime(date, options)}`;
  if (daysAgo === 1) return `${options.labels.yesterday}, ${formatTime(date, options)}`;
  return formatDateTime(date, options, now);
}

/** Time left as "M:SS" for the payment countdown ("29:59"); never negative. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
