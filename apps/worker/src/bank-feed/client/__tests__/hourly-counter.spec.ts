import { HourlyCounter } from '../hourly-counter';

const AT = (minutes: number) => new Date(Date.UTC(2026, 10, 8, 10, 0) + minutes * 60_000);

describe('HourlyCounter (S9 F-I1)', () => {
  it('logs the first event of each hour, counts the rest, and reports the last hour on the next', () => {
    const counter = new HourlyCounter();
    expect(counter.hit('HUMO_BOT', AT(0))).toEqual({ logNow: true, previousLoggedHourCount: 0 });
    expect(counter.hit('HUMO_BOT', AT(10))).toEqual({ logNow: false, previousLoggedHourCount: 0 });
    expect(counter.hit('HUMO_BOT', AT(59))).toEqual({ logNow: false, previousLoggedHourCount: 0 });
    expect(counter.hit('HUMO_BOT', AT(60))).toEqual({ logNow: true, previousLoggedHourCount: 3 });
  });

  it('keeps each source apart', () => {
    const counter = new HourlyCounter();
    counter.hit('HUMO_BOT', AT(0));
    expect(counter.hit('UZCARD_BOT', AT(1))).toEqual({ logNow: true, previousLoggedHourCount: 0 });
    expect(counter.hit('HUMO_BOT', AT(2)).logNow).toBe(false);
  });
});
