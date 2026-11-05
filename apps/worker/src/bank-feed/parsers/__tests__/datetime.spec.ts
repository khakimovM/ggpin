import { TASHKENT_UTC_OFFSET_MINUTES, parseBankDateTime } from '../datetime';

const at = (iso: string) => ({ ok: true, at: new Date(iso) });

describe('parseBankDateTime', () => {
  it('Tashkent is a fixed UTC+5 (assumption, confirmed in S11)', () => {
    expect(TASHKENT_UTC_OFFSET_MINUTES).toBe(300);
  });

  it.each([
    ['Humo "HH:MM DD.MM.YYYY"', '12:00 01.01.2030', '2030-01-01T07:00:00.000Z'],
    ['Uzcard "DD.MM.YY HH:MM"', '01.01.30 12:00', '2030-01-01T07:00:00.000Z'],
    [
      'local midnight falls on the previous UTC day',
      '00:30 01.01.2030',
      '2029-12-31T19:30:00.000Z',
    ],
    ['last minute of the day', '23:59 31.12.2030', '2030-12-31T18:59:00.000Z'],
    ['leap day', '29.02.32 12:00', '2032-02-29T07:00:00.000Z'],
    ['YY 00 is 2000', '01.01.00 12:00', '2000-01-01T07:00:00.000Z'],
    ['YY 99 is 2099', '01.01.99 12:00', '2099-01-01T07:00:00.000Z'],
  ])('%s', (_, text, iso) => {
    expect(parseBankDateTime(text)).toEqual(at(iso));
  });

  it.each([
    ['31 February', '12:00 31.02.2030'],
    ['31 February, Uzcard', '31.02.30 12:00'],
    ['29 February in a common year', '29.02.31 12:00'],
    ['31 April', '12:00 31.04.2030'],
    ['day 00', '12:00 00.01.2030'],
    ['month 00', '12:00 01.00.2030'],
    ['month 13', '12:00 01.13.2030'],
    ['hour 24', '24:00 01.01.2030'],
    ['minute 60', '12:60 01.01.2030'],
    ['year before 2000', '12:00 01.01.1999'],
    ['year after 2099', '12:00 01.01.2100'],
  ])('a non-existent moment is DATE: %s', (_, text) => {
    expect(parseBankDateTime(text)).toEqual({ ok: false, reason: 'DATE' });
  });

  it.each([
    ['one-digit hour', '1:00 01.01.2030'],
    ['one-digit day and month', '12:00 1.1.2030'],
    ['two-digit year after the time', '12:00 01.01.30'],
    ['four-digit year before the time', '01.01.2030 12:00'],
    ['slashes', '01/01/2030 12:00'],
    ['dot in the time', '12.00 01.01.2030'],
    ['seconds', '12:00:00 01.01.2030'],
    ['trailing text', '12:00 01.01.2030 UTC'],
    ['empty', ''],
  ])('an unknown shape is DATE_FORMAT: %s', (_, text) => {
    expect(parseBankDateTime(text)).toEqual({ ok: false, reason: 'DATE_FORMAT' });
  });
});
