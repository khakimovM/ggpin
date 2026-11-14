import { describe, expect, it } from 'vitest';
import {
  NOTIFY_DEDUPE_SEC,
  QUEUE_EVENTS_MAX_LEN,
  QUEUE_JOB_DEFAULTS,
  QUEUE_NAMES,
  QUEUES,
  RECIPIENT_CHECK_RETENTION_SEC,
  queueStreamOptions,
} from './index';

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
    // validate-recipient: one attempt (phase 5 S3a fix round; the worker answers UNAVAILABLE
    // instead of throwing, so a retry would only repeat a provider call nobody waits for).
    expect(QUEUE_JOB_DEFAULTS[QUEUES.VALIDATE_RECIPIENT].attempts).toBe(1);
    for (const cron of [
      QUEUES.PRICE_SYNC,
      QUEUES.FRAGMENT_KEEPALIVE,
      QUEUES.RECONCILE,
      QUEUES.TOPUP_EXPIRE,
    ]) {
      expect(QUEUE_JOB_DEFAULTS[cron].attempts).toBe(1);
    }
    // payment-reconcile: 3 attempts, 60 s exponential; then the reconcileFailed alert.
    expect(QUEUE_JOB_DEFAULTS[QUEUES.PAYMENT_RECONCILE].attempts).toBe(3);
    expect(QUEUE_JOB_DEFAULTS[QUEUES.PAYMENT_RECONCILE].backoff.delay).toBe(60_000);
    // Phase 4 queues (docs/02-ARCHITECTURE.md): bank-message and notify retry with 2 s backoff.
    for (const name of [QUEUES.BANK_MESSAGE, QUEUES.NOTIFY]) {
      expect(QUEUE_JOB_DEFAULTS[name].attempts).toBe(5);
      expect(QUEUE_JOB_DEFAULTS[name].backoff.delay).toBe(2_000);
    }
    // card-limit has its own, longer budget: a busy card must not cost the message anything.
    expect(QUEUE_JOB_DEFAULTS[QUEUES.CARD_LIMIT].attempts).toBe(8);
    expect(QUEUE_JOB_DEFAULTS[QUEUES.CARD_LIMIT].backoff.delay).toBe(2_000);
  });

  // A replayed bank message re-adds its notify jobs; the retained id is what drops them.
  it('keeps notify ids for the dedupe window, and outbox texts briefly', () => {
    expect(NOTIFY_DEDUPE_SEC).toBe(30 * 24 * 60 * 60);
    expect(QUEUE_JOB_DEFAULTS[QUEUES.NOTIFY].removeOnComplete.age).toBe(NOTIFY_DEDUPE_SEC);
    expect(QUEUE_JOB_DEFAULTS[QUEUES.NOTIFY].removeOnComplete.count).toBeGreaterThanOrEqual(
      100_000,
    );
    for (const keep of ['removeOnComplete', 'removeOnFail'] as const) {
      expect(QUEUE_JOB_DEFAULTS[QUEUES.TG_OUTBOX][keep].age).toBeLessThanOrEqual(24 * 60 * 60);
    }
  });

  it('keeps finished validate-recipient jobs (personal data) for one 60 s bucket only', () => {
    expect(RECIPIENT_CHECK_RETENTION_SEC).toBe(60);
    for (const keep of ['removeOnComplete', 'removeOnFail'] as const) {
      expect(QUEUE_JOB_DEFAULTS[QUEUES.VALIDATE_RECIPIENT][keep].age).toBe(
        RECIPIENT_CHECK_RETENTION_SEC,
      );
    }
  });

  it('bounds the validate-recipient events stream; other queues keep the BullMQ default', () => {
    expect(QUEUE_EVENTS_MAX_LEN[QUEUES.VALIDATE_RECIPIENT]).toBe(500);
    expect(queueStreamOptions(QUEUES.VALIDATE_RECIPIENT)).toEqual({
      streams: { events: { maxLen: 500 } },
    });
    for (const name of QUEUE_NAMES.filter((n) => n !== QUEUES.VALIDATE_RECIPIENT)) {
      expect(queueStreamOptions(name)).toEqual({});
    }
  });
});
