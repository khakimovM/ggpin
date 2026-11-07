import { TASHKENT_UTC_OFFSET_MINUTES } from '@repo/shared';

// The bots print local time, Asia/Tashkent = UTC+5 (docs/05-PAYMENTS.md §5 rule 5; confirmed
// against a real message in phase 4, slice S11). The constant lives in @repo/shared.
export { TASHKENT_UTC_OFFSET_MINUTES };

// "HH:MM DD.MM.YYYY" (Humo) and "DD.MM.YY HH:MM" (Uzcard); either bot may use either.
const TIME_FIRST = /^(\d{2}):(\d{2}) (\d{2})\.(\d{2})\.(\d{4})$/;
const DATE_FIRST = /^(\d{2})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})$/;

// Bank notifications are about now; a year outside this range is a misparse, and it also keeps
// Date.UTC away from its 0-99 → 1900-1999 year mapping.
const MIN_YEAR = 2000;
const MAX_YEAR = 2099;

export type BankDateTimeResult =
  | { readonly ok: true; readonly at: Date }
  | { readonly ok: false; readonly reason: 'DATE_FORMAT' | 'DATE' };

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** Bank-printed local time → the UTC instant. A shape mismatch and a non-existent date differ. */
export function parseBankDateTime(text: string): BankDateTimeResult {
  const parts = toLocalParts(text);
  if (parts === null) return { ok: false, reason: 'DATE_FORMAT' };
  if (!isValidLocal(parts)) return { ok: false, reason: 'DATE' };
  const localMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return { ok: true, at: new Date(localMs - TASHKENT_UTC_OFFSET_MINUTES * 60_000) };
}

function toLocalParts(text: string): LocalParts | null {
  const timeFirst = TIME_FIRST.exec(text);
  if (timeFirst) {
    const [, hour, minute, day, month, year] = timeFirst;
    return {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
    };
  }
  const dateFirst = DATE_FIRST.exec(text);
  if (dateFirst) {
    const [, day, month, year, hour, minute] = dateFirst;
    return {
      year: 2000 + Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
    };
  }
  return null;
}

function isValidLocal({ year, month, day, hour, minute }: LocalParts): boolean {
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || day < 1) return false;
  // Day 0 of the next month is the last day of this one.
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
