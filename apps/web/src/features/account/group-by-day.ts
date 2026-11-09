import type { Locale } from '@repo/shared';
import { DISPLAY_TIME_ZONE } from '../../lib/format/date';

// The history is grouped under day headings ("Bugun", "Kecha", "27-oktabr"). Grouping is a way of
// laying out what the server sent, in Tashkent time like every other date of the app; the order
// inside a group is the server's (newest first).

export interface DayGroup<T> {
  /** `YYYY-MM-DD` in the display time zone. */
  key: string;
  label: string;
  items: T[];
}

export interface DayLabels {
  today: string;
  yesterday: string;
  /** Heading of rows whose date cannot be read (the schema makes that unlikely, never impossible). */
  unknown: string;
}

function dayParts(date: Date): { key: string; number: number; year: string } {
  const key = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(date);
  const [year, month, day] = key.split('-').map(Number);
  return {
    key,
    number: Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / 86_400_000,
    year: String(year),
  };
}

export function groupByDay<T>(
  items: readonly T[],
  dateOf: (item: T) => string,
  options: { locale: Locale; labels: DayLabels; now?: Date },
): DayGroup<T>[] {
  const now = dayParts(options.now ?? new Date());
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const date = new Date(dateOf(item));
    // A date that does not parse must not hide the row: it lands in the group of its neighbour.
    const parts = Number.isNaN(date.getTime()) ? undefined : dayParts(date);
    const last = groups[groups.length - 1];
    if (parts === undefined) {
      if (last) last.items.push(item);
      else groups.push({ key: 'unknown', label: options.labels.unknown, items: [item] });
      continue;
    }
    if (last?.key === parts.key) {
      last.items.push(item);
      continue;
    }
    const ago = now.number - parts.number;
    const label =
      ago === 0
        ? options.labels.today
        : ago === 1
          ? options.labels.yesterday
          : new Intl.DateTimeFormat(options.locale, {
              day: 'numeric',
              month: 'long',
              year: parts.year === now.year ? undefined : 'numeric',
              timeZone: DISPLAY_TIME_ZONE,
            }).format(date);
    groups.push({ key: parts.key, label, items: [item] });
  }
  return groups;
}
