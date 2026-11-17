import type { FixedWindowCounter, WindowHit } from '../../../infra/redis/fixed-window-counter';
import { AdminThrottle } from '../common/admin-throttle';

function throttleWith(hit: () => Promise<WindowHit>): AdminThrottle {
  const counter: Pick<FixedWindowCounter, 'hit'> = { hit };
  return new AdminThrottle(counter as FixedWindowCounter);
}

// The log window of lines outsiders can trigger at will (S2-m3, S2R-4).
describe('AdminThrottle.firstInWindow', () => {
  it('true for the first hit of a window, false for the rest', async () => {
    let count = 0;
    const throttle = throttleWith(() => Promise.resolve({ count: (count += 1), ttlSec: 600 }));
    expect(await throttle.firstInWindow('k', 600)).toBe(true);
    expect(await throttle.firstInWindow('k', 600)).toBe(false);
    expect(await throttle.firstInWindow('k', 600)).toBe(false);
  });

  it('Redis down: true every time, so the security line is still written as a warn', async () => {
    const throttle = throttleWith(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(await throttle.firstInWindow('k', 600)).toBe(true);
    expect(await throttle.firstInWindow('k', 600)).toBe(true);
  });
});
