import { describe, expect, it } from 'vitest';
import { groupByDay } from '../group-by-day';

const labels = { today: 'Bugun', yesterday: 'Kecha', unknown: 'No date' };
// 2026-11-08 10:00 in Tashkent (UTC+5).
const now = new Date('2026-11-08T05:00:00.000Z');
const at = (iso: string) => ({ createdAt: iso });
const options = { locale: 'uz' as const, labels, now };

describe('groupByDay', () => {
  it('names today and yesterday and keeps the server order inside a day', () => {
    const groups = groupByDay(
      [
        at('2026-11-08T04:00:00.000Z'),
        at('2026-11-08T01:00:00.000Z'),
        at('2026-11-07T10:00:00.000Z'),
        at('2026-10-27T10:00:00.000Z'),
      ],
      (item) => item.createdAt,
      options,
    );
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Bugun', 2],
      ['Kecha', 1],
      [expect.stringMatching(/27/), 1],
    ]);
  });

  it('cuts the day at Tashkent midnight, not at UTC midnight', () => {
    // 20:30 UTC on the 7th is 01:30 on the 8th in Tashkent: today.
    const [group] = groupByDay([at('2026-11-07T20:30:00.000Z')], (i) => i.createdAt, options);
    expect(group?.label).toBe('Bugun');
  });

  it('writes the year only for another year, and in the page language', () => {
    const [group] = groupByDay([at('2025-03-02T10:00:00.000Z')], (i) => i.createdAt, {
      ...options,
      locale: 'ru',
    });
    expect(group?.label).toMatch(/2025/);
    expect(group?.label).toMatch(/марта/);
  });

  it('keeps a row whose date does not parse: with its neighbour, or under the "unknown" heading', () => {
    const after = groupByDay(
      [at('2026-11-08T04:00:00.000Z'), at('nope')],
      (i) => i.createdAt,
      options,
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.items).toHaveLength(2);
    const first = groupByDay([at('nope')], (i) => i.createdAt, options);
    expect(first.map((g) => g.label)).toEqual(['No date']);
  });

  it('is empty for no rows', () => {
    expect(groupByDay([], () => '', options)).toEqual([]);
  });
});
