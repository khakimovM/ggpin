import { TG_OUTBOX_PRIORITY } from '@repo/shared';
import { gateDelayMs } from '../tg-outbox.consumer';

// The per-chat gate keeps 1 msg/s and carries the priority in the return time (re-review MAJOR):
// the delayed set is ordered by time, not priority.
describe('chat gate delay', () => {
  const { critical, normal } = TG_OUTBOX_PRIORITY;

  it('a critical job comes back exactly when the gate opens', () => {
    expect(gateDelayMs(640, critical)).toBe(640);
    expect(gateDelayMs(0, critical)).toBe(1);
  });

  it('an ordinary job comes back 250-500 ms after the gate opens, never before', () => {
    expect(gateDelayMs(640, normal, () => 0)).toBe(890);
    expect(gateDelayMs(640, normal, () => 0.999)).toBe(1139);
    expect(gateDelayMs(640, undefined, () => 0.5)).toBe(1015);
  });

  it('every ordinary return is later than every critical return for the same gate', () => {
    for (const ttl of [1, 250, 999, 1000]) {
      expect(gateDelayMs(ttl, normal, () => 0)).toBeGreaterThan(gateDelayMs(ttl, critical));
    }
  });

  it('a gate that just expired (-2): retry at once; no expiry (-1): a full second', () => {
    expect(gateDelayMs(-2, critical)).toBe(5);
    expect(gateDelayMs(-2, normal, () => 0)).toBe(255);
    expect(gateDelayMs(-1, critical)).toBe(1000);
  });
});
