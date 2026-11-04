import { describe, expect, it } from 'vitest';
import {
  SIMULATOR_SOURCE,
  derivedFxSource,
  isDerivedFxSource,
  parseDerivedFxSource,
} from './price-sources';

describe('price source labels', () => {
  it('names simulated rows "simulator" (the API refuses exactly this in production)', () => {
    expect(SIMULATOR_SOURCE).toBe('simulator');
  });

  it('builds and parses a derived source round trip, parents in TON_USDT, USDT_UZS order', () => {
    const source = derivedFxSource('ckx12-ab_C', 'ckx34-de_F');
    expect(source).toBe('derived:ckx12-ab_C*ckx34-de_F');
    expect(isDerivedFxSource(source)).toBe(true);
    expect(parseDerivedFxSource(source)).toEqual(['ckx12-ab_C', 'ckx34-de_F']);
  });

  it.each([
    ['', 'b'],
    ['a', ''],
    ['a*b', 'c'],
    ['a', 'b c'],
    ['a\n', 'b'],
  ])('refuses to build a derived source from ids %j and %j', (first, second) => {
    expect(() => derivedFxSource(first, second)).toThrow(RangeError);
  });

  it('a plain source is not derived', () => {
    for (const source of ['simulator', 'cbu', 'binance', '', 'Derived:a*b']) {
      expect(isDerivedFxSource(source)).toBe(false);
    }
  });

  it.each([
    'derived:',
    'derived:a',
    'derived:a*',
    'derived:*b',
    'derived:a*b*c',
    'derived:a b*c',
    'derived:a*b ',
    'derived:a+b',
    'derived:a*b\n',
    'Derived:a*b',
    'simulator',
  ])('rejects the malformed source %j', (source) => {
    expect(parseDerivedFxSource(source)).toBeNull();
  });
});
