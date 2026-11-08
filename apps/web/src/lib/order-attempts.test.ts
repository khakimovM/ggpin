import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTEMPT_LABEL_MAX,
  beginAttempt,
  forgetKey,
  getAttempt,
  resetOrderAttempts,
  resolveAttempt,
  subscribeAttempts,
} from './order-attempts';

const STORAGE_KEY = (userId: string) => `ggpin:order-attempt:v1:${userId}`;
const NOW = new Date('2026-11-08T10:00:00Z');
const KEY = 'a-valid-key-from-before';

// Subscribing sweeps damaged and stale records out of storage (never a render: see 'a pure read').
const sweepNow = () => subscribeAttempts(() => undefined)();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetOrderAttempts();
});
afterEach(() => vi.useRealTimers());

describe('write-ahead', () => {
  it('beginAttempt writes the record at once: a quote id, a key, a time and the label, nothing else', () => {
    const { attempt, retry } = beginAttempt('u1', 'q1', 'Telegram Stars · 50 ⭐');
    expect(retry).toBe(false);
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY('u1')) ?? '') as Record<
      string,
      unknown
    >;
    expect(stored).toEqual({
      quoteId: 'q1',
      key: attempt.key,
      at: NOW.getTime(),
      label: 'Telegram Stars · 50 ⭐',
    });
    expect(Object.keys(stored).sort()).toEqual(['at', 'key', 'label', 'quoteId']);
  });

  it('the key of a quote is the same on every later ask, and a spent key is not reused', () => {
    const first = beginAttempt('u1', 'q1', 'x').attempt.key;
    resolveAttempt('u1', 'q1');
    expect(beginAttempt('u1', 'q1', 'x').attempt.key).toBe(first);
    resolveAttempt('u1', 'q1');
    forgetKey('q1');
    expect(beginAttempt('u1', 'q1', 'x').attempt.key).not.toBe(first);
  });

  it('is ONE slot per user: a second begin returns the unresolved record untouched', () => {
    const first = beginAttempt('u1', 'q1', 'one').attempt;
    const second = beginAttempt('u1', 'q2', 'two');
    expect(second.retry).toBe(true);
    expect(second.attempt).toBe(first);
    expect(getAttempt('u1')?.quoteId).toBe('q1');
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY('u1')) ?? '') as {
      quoteId: string;
    };
    expect(stored.quoteId).toBe('q1');
  });

  it('a record that is only "in flight" (the tab died before the answer) reads as unresolved after a reload', () => {
    beginAttempt('u1', 'q1', 'x');
    // a reload: the module forgets its memory but the storage stays
    const raw = window.localStorage.getItem(STORAGE_KEY('u1'));
    resetOrderAttempts();
    window.localStorage.setItem(STORAGE_KEY('u1'), raw ?? '');
    expect(getAttempt('u1')).toMatchObject({ quoteId: 'q1' });
  });

  it('resolving removes the record from memory and storage, and notifies', () => {
    const listener = vi.fn();
    const off = subscribeAttempts(listener);
    beginAttempt('u1', 'q1', 'x');
    expect(listener).toHaveBeenCalledTimes(1);
    resolveAttempt('u1', 'q1');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getAttempt('u1')).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY('u1'))).toBeNull();
    off();
    beginAttempt('u1', 'q2', 'x');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('resolving another quote changes nothing', () => {
    beginAttempt('u1', 'q1', 'x');
    resolveAttempt('u1', 'q2');
    expect(getAttempt('u1')?.quoteId).toBe('q1');
  });

  it('the object is the same until it changes', () => {
    const { attempt } = beginAttempt('u1', 'q1', 'x');
    expect(getAttempt('u1')).toBe(attempt);
    expect(getAttempt('u1')).toBe(getAttempt('u1'));
  });
});

describe('per user', () => {
  it('another account does not see the record, and signing out does not remove it', () => {
    beginAttempt('u1', 'q1', 'x');
    expect(getAttempt('u2')).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY('u2'))).toBeNull();
    // (nothing in the sign-out path touches the module: the same user finds the record again)
    expect(getAttempt('u1')?.quoteId).toBe('q1');
  });

  it('both users keep their own slot', () => {
    beginAttempt('u1', 'q1', 'one');
    beginAttempt('u2', 'q9', 'two');
    expect(getAttempt('u1')?.quoteId).toBe('q1');
    expect(getAttempt('u2')?.quoteId).toBe('q9');
  });
});

describe('another tab', () => {
  const fire = (key: string | null, newValue: string | null) =>
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }));

  it('a record written by another tab is seen at once', () => {
    expect(getAttempt('u1')).toBeNull(); // installs the listener
    const listener = vi.fn();
    subscribeAttempts(listener);
    const record = { quoteId: 'q7', key: KEY, at: NOW.getTime(), label: 'Telegram Premium' };
    fire(STORAGE_KEY('u1'), JSON.stringify(record));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getAttempt('u1')).toEqual(record);
  });

  it('a record resolved in another tab disappears here', () => {
    beginAttempt('u1', 'q1', 'x');
    const listener = vi.fn();
    subscribeAttempts(listener);
    fire(STORAGE_KEY('u1'), null);
    expect(getAttempt('u1')).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('an identical value, a foreign key and a damaged value do nothing', () => {
    const { attempt } = beginAttempt('u1', 'q1', 'x');
    const listener = vi.fn();
    subscribeAttempts(listener);
    fire(STORAGE_KEY('u1'), JSON.stringify(attempt));
    fire('something-else', '{}');
    expect(listener).not.toHaveBeenCalled();
    fire(STORAGE_KEY('u1'), '{nope');
    expect(getAttempt('u1')).toBeNull(); // a damaged record is no record
  });

  it('storage.clear() in another tab clears the cache', () => {
    beginAttempt('u1', 'q1', 'x');
    window.localStorage.clear();
    fire(null, null);
    expect(getAttempt('u1')).toBeNull();
  });
});

describe('what is read back', () => {
  const write = (userId: string, patch: Record<string, unknown>) =>
    window.localStorage.setItem(
      STORAGE_KEY(userId),
      JSON.stringify({ quoteId: 'q9', key: KEY, at: NOW.getTime() - 1000, label: 'x', ...patch }),
    );

  it('reads a good record', () => {
    write('u1', {});
    expect(getAttempt('u1')).toMatchObject({ quoteId: 'q9', key: KEY });
  });

  it('a time in the near future (a fast clock) is accepted, a far-future one is dropped', () => {
    write('u1', { at: NOW.getTime() + 30_000 });
    expect(getAttempt('u1')).not.toBeNull();
    resetOrderAttempts();
    write('u1', { at: NOW.getTime() + 61_000 });
    expect(getAttempt('u1')).toBeNull();
    sweepNow();
    expect(window.localStorage.getItem(STORAGE_KEY('u1'))).toBeNull();
  });

  it('a record older than a day is dropped', () => {
    write('u1', { at: NOW.getTime() - 25 * 60 * 60 * 1000 });
    expect(getAttempt('u1')).toBeNull();
    sweepNow();
    expect(window.localStorage.getItem(STORAGE_KEY('u1'))).toBeNull();
  });

  it('a record that turns a day old while the page is open is dropped too', () => {
    beginAttempt('u1', 'q1', 'x');
    vi.setSystemTime(new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
    expect(getAttempt('u1')).toBeNull();
  });

  it.each([
    ['unknown fields', JSON.stringify({ quoteId: 'q9', key: KEY, at: 1, label: 'x', total: '5' })],
    [
      'a key that is not a key',
      JSON.stringify({ quoteId: 'q9', key: 'no good!', at: 1, label: '' }),
    ],
    [
      'a quote id that is not an id',
      JSON.stringify({ quoteId: '../x', key: KEY, at: 1, label: '' }),
    ],
    [
      'a label that is too long',
      JSON.stringify({ quoteId: 'q9', key: KEY, at: 1, label: 'x'.repeat(ATTEMPT_LABEL_MAX + 1) }),
    ],
    [
      'a label with a control character',
      JSON.stringify({ quoteId: 'q9', key: KEY, at: 1, label: 'a\u0007b' }),
    ],
  ])('ignores an entry of an unknown shape (%s) and a sweep leaves it alone', (_name, raw) => {
    window.localStorage.setItem(STORAGE_KEY('u1'), raw);
    expect(getAttempt('u1')).toBeNull();
    sweepNow();
    // valid JSON of a shape this version does not know may belong to a newer tab: not deleted
    expect(window.localStorage.getItem(STORAGE_KEY('u1'))).toBe(raw);
  });

  it('a sweep removes broken JSON, and a known record that has expired', () => {
    window.localStorage.setItem(STORAGE_KEY('u1'), '{nope');
    window.localStorage.setItem(
      STORAGE_KEY('u2'),
      JSON.stringify({ quoteId: 'q9', key: KEY, at: NOW.getTime() - 25 * 3600_000, label: 'x' }),
    );
    window.localStorage.setItem(
      STORAGE_KEY('u3'),
      JSON.stringify({ quoteId: 'q9', key: KEY, at: NOW.getTime() + 61_000, label: 'x' }),
    );
    window.localStorage.setItem(
      STORAGE_KEY('u4'),
      JSON.stringify({ quoteId: 'q9', key: KEY, at: NOW.getTime() - 1000, label: 'x' }),
    );
    sweepNow();
    expect(window.localStorage.getItem(STORAGE_KEY('u1'))).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY('u2'))).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY('u3'))).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY('u4'))).not.toBeNull();
  });

  it('the old, unversioned key is never read', () => {
    window.localStorage.setItem(
      'ggpin:order-attempt:u1',
      JSON.stringify({ quoteId: 'q9', key: KEY, at: NOW.getTime() - 1000, label: 'x' }),
    );
    expect(getAttempt('u1')).toBeNull();
  });

  it('the label is cut to its limit and stripped of control characters when written', () => {
    const { attempt } = beginAttempt('u1', 'q1', `a\u0007${'b'.repeat(500)}`);
    expect(attempt.label).toHaveLength(ATTEMPT_LABEL_MAX);
    expect(attempt.label.startsWith('a b')).toBe(true);
  });
});

describe('storage that does not work', () => {
  it('the record lives in memory when every storage call throws', () => {
    const boom = () => {
      throw new Error('blocked');
    };
    const spies = [
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom),
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom),
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom),
    ];
    try {
      const { attempt } = beginAttempt('u1', 'q1', 'x');
      expect(getAttempt('u1')).toBe(attempt);
      resolveAttempt('u1', 'q1');
      expect(getAttempt('u1')).toBeNull();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
