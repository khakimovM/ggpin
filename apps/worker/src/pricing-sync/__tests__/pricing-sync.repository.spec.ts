import { MAX_CLOCK_SKEW_MS } from '@repo/shared';
import { latestAnchorCreatedAt } from '../pricing-sync.repository';

// The query itself (createdAt <= this bound) is proven on Postgres in price-sync.e2e-spec.ts.
describe('latestAnchorCreatedAt', () => {
  it('allows exactly the shared clock skew (1 minute) past now', () => {
    expect(MAX_CLOCK_SKEW_MS).toBe(60_000);
    const now = new Date('2026-11-04T10:00:00.000Z');
    expect(latestAnchorCreatedAt(now).toISOString()).toBe('2026-11-04T10:01:00.000Z');
    expect(now.toISOString()).toBe('2026-11-04T10:00:00.000Z'); // not mutated
  });
});
