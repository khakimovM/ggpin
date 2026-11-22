import { describe, expect, it } from 'vitest';
import { fromOfPreset, tashkentDayStart } from '../date-range';
import { readListParams, readPage, writeListParams, writePage } from '../list-params';

const SPEC = {
  status: { default: 'all', values: ['all', 'ACTIVE', 'BLOCKED'] },
  q: { default: '', maxLength: 8 },
} as const;

describe('list filters in the URL', () => {
  it('reads defaults, known values, and drops what the spec does not allow', () => {
    expect(readListParams(new URLSearchParams(''), SPEC)).toEqual({ status: 'all', q: '' });
    expect(readListParams(new URLSearchParams('status=BLOCKED&q=%40sardor'), SPEC)).toEqual({
      status: 'BLOCKED',
      q: '@sardor',
    });
    // A hand-edited link never reaches the API as a 400: unknown values fall back, text is cut.
    expect(readListParams(new URLSearchParams('status=DROP&q=0123456789'), SPEC)).toEqual({
      status: 'all',
      q: '01234567',
    });
  });

  it('drops control characters from free text and closed values (R-12)', () => {
    const search = new URLSearchParams();
    search.set('q', 'a\u0000b\nc\u0085');
    search.set('status', 'BLOCKED\t');
    expect(readListParams(search, SPEC)).toEqual({ status: 'BLOCKED', q: 'abc' });
    const spaced = new URLSearchParams();
    spaced.set('q', '\u0007 ali ');
    expect(readListParams(spaced, SPEC).q).toBe('ali');
  });

  it('writes canonical links: defaults removed, page reset, other params kept', () => {
    const next = writeListParams(new URLSearchParams('status=ACTIVE&page=3&tab=x'), SPEC, {
      status: 'all',
      q: 'bek',
    });
    expect(next.toString()).toBe('tab=x&q=bek');
  });

  it('keeps the page within 1..10 000', () => {
    expect(readPage(new URLSearchParams('page=0'))).toBe(1);
    expect(readPage(new URLSearchParams('page=abc'))).toBe(1);
    expect(readPage(new URLSearchParams('page=4'))).toBe(4);
    expect(writePage(new URLSearchParams('q=a'), 1).toString()).toBe('q=a');
    expect(writePage(new URLSearchParams('q=a'), 2).toString()).toBe('q=a&page=2');
  });

  it('measures date presets in Tashkent days', () => {
    // 03:00 in Tashkent on 17.11 is still 16.11 in UTC.
    const now = new Date('2026-11-16T22:00:00Z');
    expect(tashkentDayStart(now).toISOString()).toBe('2026-11-16T19:00:00.000Z');
    expect(fromOfPreset('today', now)).toBe('2026-11-16T19:00:00.000Z');
    expect(fromOfPreset('week', now)).toBe('2026-11-10T19:00:00.000Z');
    expect(fromOfPreset('all', now)).toBeUndefined();
    expect(fromOfPreset('bogus', now)).toBeUndefined();
  });
});
