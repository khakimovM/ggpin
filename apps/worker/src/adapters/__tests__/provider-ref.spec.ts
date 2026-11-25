import { namespacedProviderRef, parseProviderRef } from '../provider-ref';

describe('provider-ref (S7, CR #2)', () => {
  it('namespaces a handle by its issuer and reads both back (a handle may contain ":")', () => {
    const stored = namespacedProviderRef('RESELLER_STARS', 'u:42');
    expect(stored).toBe('RESELLER_STARS:u:42');
    expect(parseProviderRef(stored)).toEqual({ adapter: 'RESELLER_STARS', ref: 'u:42' });
  });

  it('refuses a code that is not an adapter code, a blank handle, or a result over 256', () => {
    expect(() => namespacedProviderRef('fragment', 'x')).toThrow(RangeError);
    expect(() => namespacedProviderRef('FRAG:MENT', 'x')).toThrow(RangeError);
    expect(() => namespacedProviderRef('FRAGMENT', ' ')).toThrow();
    expect(() => namespacedProviderRef('FRAGMENT', 'r'.repeat(248))).toThrow();
    expect(namespacedProviderRef('FRAGMENT', 'r'.repeat(247))).toHaveLength(256);
  });

  it('a handle without a namespace (written before S7) parses as null', () => {
    for (const legacy of ['sim_aziz', ':x', 'lower:x', 'FRAGMENT:', 'FRAGMENT: ', '1ABC:x']) {
      expect(parseProviderRef(legacy)).toBeNull();
    }
  });
});
