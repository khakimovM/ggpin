import { describe, expect, it } from 'vitest';
import { tashkentDayKey } from './tashkent-time';

describe('tashkentDayKey', () => {
  it('turns at Tashkent midnight (19:00 UTC), not at UTC midnight', () => {
    expect(tashkentDayKey(new Date('2030-03-14T18:59:59.999Z'))).toBe('20300314');
    expect(tashkentDayKey(new Date('2030-03-14T19:00:00.000Z'))).toBe('20300315');
    expect(tashkentDayKey(new Date('2030-03-15T00:30:00.000Z'))).toBe('20300315');
  });

  it('gives the reconciliation run at 03:00 Tashkent (22:00 UTC) its local day', () => {
    expect(tashkentDayKey(new Date('2030-12-31T22:00:00.000Z'))).toBe('20310101');
  });

  it('pads month and day to a fixed eight-digit key', () => {
    expect(tashkentDayKey(new Date('2030-01-04T12:00:00.000Z'))).toMatch(/^\d{8}$/);
    expect(tashkentDayKey(new Date('2030-01-04T12:00:00.000Z'))).toBe('20300104');
  });
});
