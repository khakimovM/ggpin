import { limitCrossing, sumsAfter } from '../card-limit-rules';

const verifiedAt = new Date('2026-10-20T10:00:00Z');
const monthStart = new Date('2026-10-31T19:00:00Z'); // 1 November, Asia/Tashkent
const card = { receiveLimitTiyin: 1_000n, monthlyLimitTiyin: 500n, verifiedAt };
const before = { receivedTiyin: 800n, receivedMonthTiyin: 300n };

describe('sumsAfter (money received before this message, plus this credit)', () => {
  it('adds a credit of this month to both sums', () => {
    const credit = { amountTiyin: 100n, tgDate: new Date('2026-11-05T08:00:00Z') };
    expect(sumsAfter(card, before, credit, monthStart)).toEqual({
      card,
      receivedTiyin: 900n,
      receivedMonthTiyin: 400n,
      reservedTiyin: 0n,
    });
  });

  it('adds a credit of an earlier month to the lifetime sum only', () => {
    const credit = { amountTiyin: 100n, tgDate: new Date('2026-10-25T08:00:00Z') };
    expect(sumsAfter(card, before, credit, monthStart)).toMatchObject({
      receivedTiyin: 900n,
      receivedMonthTiyin: 300n,
    });
  });

  it('adds nothing for a credit before verification or on an unverified card', () => {
    const early = { amountTiyin: 100n, tgDate: new Date('2026-10-19T08:00:00Z') };
    expect(sumsAfter(card, before, early, monthStart)).toMatchObject(before);
    const credit = { amountTiyin: 100n, tgDate: new Date('2026-11-05T08:00:00Z') };
    expect(sumsAfter({ ...card, verifiedAt: null }, before, credit, monthStart)).toMatchObject(
      before,
    );
  });

  it('counts the month from verification when the card was verified this month', () => {
    const late = { ...card, verifiedAt: new Date('2026-11-03T00:00:00Z') };
    const beforeVerify = { amountTiyin: 100n, tgDate: new Date('2026-11-02T00:00:00Z') };
    expect(sumsAfter(late, before, beforeVerify, monthStart)).toMatchObject(before);
    const afterVerify = { amountTiyin: 100n, tgDate: new Date('2026-11-04T00:00:00Z') };
    expect(sumsAfter(late, before, afterVerify, monthStart)).toMatchObject({
      receivedTiyin: 900n,
      receivedMonthTiyin: 400n,
    });
  });
});

describe('limitCrossing (L7: one alert per threshold crossed)', () => {
  it.each([
    [0, 79, null],
    [79, 80, 'NEAR'],
    [50, 99, 'NEAR'],
    [80, 95, null],
    [79, 100, 'FULL'],
    [99, 100, 'FULL'],
    [0, 250, 'FULL'],
    [100, 120, null],
    [85, 100, 'FULL'],
  ] as const)('%d %% -> %d %% is %s', (before, after, expected) => {
    expect(limitCrossing(before, after)).toBe(expected);
  });
});
