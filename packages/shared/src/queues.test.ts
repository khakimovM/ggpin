import { describe, expect, it } from 'vitest';
import { QUEUE_JOB_DEFAULTS, QUEUE_NAMES, QUEUES } from './index';

describe('queues', () => {
  it('lists every queue name once', () => {
    expect(QUEUE_NAMES).toEqual(Object.values(QUEUES));
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
  });

  it('uses names BullMQ accepts (no ":" — it is the Redis key separator)', () => {
    for (const name of QUEUE_NAMES) expect(name).toMatch(/^[a-z][a-z-]*$/);
  });

  it('has bounded defaults for every queue', () => {
    for (const name of QUEUE_NAMES) {
      const defaults = QUEUE_JOB_DEFAULTS[name];
      expect(defaults.attempts).toBeGreaterThanOrEqual(1);
      expect(defaults.backoff.type).toBe('exponential');
      expect(defaults.backoff.delay).toBeGreaterThan(0);
      for (const keep of [defaults.removeOnComplete, defaults.removeOnFail]) {
        expect(keep.age).toBeGreaterThan(0);
        expect(keep.count).toBeGreaterThan(0);
      }
    }
  });

  it('matches the retry policy in docs/02-ARCHITECTURE.md', () => {
    expect(QUEUE_JOB_DEFAULTS[QUEUES.FULFILL_ORDER].attempts).toBe(5);
    expect(QUEUE_JOB_DEFAULTS[QUEUES.VALIDATE_RECIPIENT].attempts).toBe(2);
    for (const cron of [
      QUEUES.PRICE_SYNC,
      QUEUES.FRAGMENT_KEEPALIVE,
      QUEUES.RECONCILE,
      QUEUES.PAYMENT_RECONCILE,
    ]) {
      expect(QUEUE_JOB_DEFAULTS[cron].attempts).toBe(1);
    }
  });
});
