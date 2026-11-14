import { describe, expect, it } from 'vitest';
import {
  formatCountdown,
  formatDateTime,
  formatDay,
  formatFullDay,
  formatTime,
  formatUserDateTime,
} from './date';

const TZ = 'Asia/Tashkent'; // UTC+5, so 09:05Z is 14:05
const at = (iso: string): Date => new Date(iso);
const LABELS = {
  uz: { today: 'Bugun', yesterday: 'Kecha' },
  ru: { today: 'Сегодня', yesterday: 'Вчера' },
} as const;

describe('formatDateTime', () => {
  it('Uzbek: "15-noyabr, 14:05"', () => {
    expect(
      formatDateTime(
        at('2026-11-15T09:05:00Z'),
        { locale: 'uz', timeZone: TZ },
        at('2026-11-20T00:00:00Z'),
      ),
    ).toBe('15-noyabr, 14:05');
  });

  it('Russian: "15 ноября, 14:05"', () => {
    expect(
      formatDateTime(
        at('2026-11-15T09:05:00Z'),
        { locale: 'ru', timeZone: TZ },
        at('2026-11-20T00:00:00Z'),
      ),
    ).toBe('15 ноября, 14:05');
  });

  it('adds the year when the date is not in the current year', () => {
    const now = at('2026-11-20T00:00:00Z');
    expect(formatDateTime(at('2025-11-15T09:05:00Z'), { locale: 'uz', timeZone: TZ }, now)).toBe(
      '15-noyabr, 2025, 14:05',
    );
    expect(formatDateTime(at('2025-11-15T09:05:00Z'), { locale: 'ru', timeZone: TZ }, now)).toMatch(
      /^15 ноября 2025 г\., 14:05$/,
    );
  });

  it('uses the 24-hour clock at midnight', () => {
    expect(formatTime(at('2026-11-15T19:05:00Z'), { locale: 'uz', timeZone: TZ })).toBe('00:05');
    expect(formatTime(at('2026-11-15T19:05:00Z'), { locale: 'ru', timeZone: TZ })).toBe('00:05');
  });
});

describe('formatUserDateTime', () => {
  const now = at('2026-11-15T10:00:00Z'); // 15:00 on 15 Nov in Tashkent

  it.each(['uz', 'ru'] as const)('says today and yesterday in words (%s)', (locale) => {
    const options = { locale, timeZone: TZ, labels: LABELS[locale] };
    expect(formatUserDateTime(at('2026-11-15T09:05:00Z'), options, now)).toBe(
      `${LABELS[locale].today}, 14:05`,
    );
    expect(formatUserDateTime(at('2026-11-14T09:05:00Z'), options, now)).toBe(
      `${LABELS[locale].yesterday}, 14:05`,
    );
  });

  it('counts calendar days in the time zone, not 24-hour spans', () => {
    // 00:30 on the 16th in Tashkent; an entry from 23:50 on the 15th is "yesterday" for the user.
    const justAfterMidnight = at('2026-11-15T19:30:00Z');
    const options = { locale: 'uz', timeZone: TZ, labels: LABELS.uz } as const;
    expect(formatUserDateTime(at('2026-11-15T18:50:00Z'), options, justAfterMidnight)).toBe(
      'Kecha, 23:50',
    );
    expect(formatUserDateTime(at('2026-11-15T19:10:00Z'), options, justAfterMidnight)).toBe(
      'Bugun, 00:10',
    );
  });

  it('falls back to the full date after two days', () => {
    const options = { locale: 'uz', timeZone: TZ, labels: LABELS.uz } as const;
    expect(formatUserDateTime(at('2026-11-13T09:05:00Z'), options, now)).toBe('13-noyabr, 14:05');
  });
});

describe('formatCountdown', () => {
  it.each([
    [1_800_000, '30:00'],
    [1_799_000, '29:59'],
    [1_798_001, '29:59'], // rounds up: 0:00 means expired
    [61_000, '1:01'],
    [9_000, '0:09'],
    [0, '0:00'],
    [-5_000, '0:00'],
  ])('%i ms -> %s', (ms, text) => {
    expect(formatCountdown(ms)).toBe(text);
  });
});

describe('display time zone', () => {
  it('defaults to Tashkent time, whatever the device zone is', () => {
    // 09:05 UTC is 14:05 in Uzbekistan; no zone is passed.
    const date = at('2026-11-15T09:05:00Z');
    expect(formatTime(date, { locale: 'uz' })).toBe('14:05');
    expect(formatDateTime(date, { locale: 'ru' }, at('2026-11-20T00:00:00Z'))).toBe(
      '15 ноября, 14:05',
    );
    const options = { locale: 'uz', labels: LABELS.uz } as const;
    expect(formatUserDateTime(date, options, at('2026-11-15T10:00:00Z'))).toBe('Bugun, 14:05');
  });
});

describe('formatDay', () => {
  const NOW = at('2026-11-20T00:00:00Z');

  it('Uzbek months come from a table, not from the engine (Chromium has no Uzbek calendar data)', () => {
    const months = [
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
    ];
    months.forEach((name, index) => {
      const date = new Date(Date.UTC(2026, index, 15, 9));
      expect(formatDay(date, { locale: 'uz', timeZone: TZ }, NOW)).toBe(`15-${name}`);
    });
  });

  it('adds the year outside the current one, and counts the day in Tashkent time', () => {
    expect(formatDay(at('2025-12-31T20:30:00Z'), { locale: 'uz', timeZone: TZ }, NOW)).toBe(
      '1-yanvar',
    ); // 01:30 on 1 January in Uzbekistan
    expect(formatDay(at('2025-12-30T09:00:00Z'), { locale: 'uz', timeZone: TZ }, NOW)).toBe(
      '30-dekabr, 2025',
    );
  });
});

describe('formatFullDay (the date of a document)', () => {
  it('always names the year, in both languages', () => {
    const day = at('2026-11-13T00:00:00Z');
    expect(formatFullDay(day, { locale: 'uz', timeZone: 'UTC' })).toBe('13-noyabr, 2026');
    expect(formatFullDay(day, { locale: 'ru', timeZone: 'UTC' })).toMatch(/^13 ноября 2026\sг\.$/);
  });
});
