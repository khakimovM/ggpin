import { MAX_CLOCK_SKEW_MS } from '@repo/shared';
import { isFresh, latestAcceptedAt } from '../price-sources';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const THIRTY_MIN_MS = 1_800_000;
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

describe('isFresh', () => {
  it('is inclusive at the limit and false one millisecond later', () => {
    expect(isFresh(at(-THIRTY_MIN_MS), NOW, THIRTY_MIN_MS)).toBe(true);
    expect(isFresh(at(-THIRTY_MIN_MS - 1), NOW, THIRTY_MIN_MS)).toBe(false);
    expect(isFresh(at(-THIRTY_MIN_MS + 1), NOW, THIRTY_MIN_MS)).toBe(true);
    expect(isFresh(NOW, NOW, THIRTY_MIN_MS)).toBe(true);
  });

  // The worker stamps rows with its own clock: a minute ahead is tolerated, anything further
  // is a bad write and must not count as a current price.
  it('accepts a row up to MAX_CLOCK_SKEW_MS in the future and refuses one further ahead', () => {
    expect(MAX_CLOCK_SKEW_MS).toBe(60_000);
    expect(isFresh(at(1), NOW, THIRTY_MIN_MS)).toBe(true);
    expect(isFresh(at(MAX_CLOCK_SKEW_MS), NOW, THIRTY_MIN_MS)).toBe(true);
    expect(isFresh(at(MAX_CLOCK_SKEW_MS + 1), NOW, THIRTY_MIN_MS)).toBe(false);
    expect(isFresh(at(THIRTY_MIN_MS), NOW, THIRTY_MIN_MS)).toBe(false);
    expect(isFresh(at(365 * 24 * 3_600_000), NOW, THIRTY_MIN_MS)).toBe(false);
  });
});

describe('latestAcceptedAt', () => {
  it('is now plus the clock-skew allowance, the same edge isFresh accepts', () => {
    expect(latestAcceptedAt(NOW)).toEqual(at(MAX_CLOCK_SKEW_MS));
    expect(isFresh(latestAcceptedAt(NOW), NOW, THIRTY_MIN_MS)).toBe(true);
  });
});
