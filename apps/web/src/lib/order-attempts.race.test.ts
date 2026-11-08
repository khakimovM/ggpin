import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginAttempt,
  reassertAttempt,
  syncFromStorage,
  getAttempt,
  resetOrderAttempts,
  resolveAttempt,
  subscribeAttempts,
} from './order-attempts';

const STORAGE_KEY = (userId: string) => `ggpin:order-attempt:v1:${userId}`;
const NOW = new Date('2026-11-08T10:00:00Z');
const KEY = 'a-valid-key-from-before';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetOrderAttempts();
});
afterEach(() => vi.useRealTimers());

describe('a pure read (the snapshot of useSyncExternalStore must not write)', () => {
  const spies = () =>
    [vi.spyOn(Storage.prototype, 'setItem'), vi.spyOn(Storage.prototype, 'removeItem')] as const;

  it('reading a damaged, stale or missing record writes nothing', () => {
    window.localStorage.setItem(STORAGE_KEY('u1'), '{nope');
    window.localStorage.setItem(
      STORAGE_KEY('u2'),
      JSON.stringify({ quoteId: 'q9', key: KEY, at: NOW.getTime() - 48 * 3600_000, label: 'x' }),
    );
    const [set, remove] = spies();
    try {
      expect(getAttempt('u1')).toBeNull();
      expect(getAttempt('u2')).toBeNull();
      expect(getAttempt('u3')).toBeNull();
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      set.mockRestore();
      remove.mockRestore();
    }
  });

  it('a record that goes stale while the page is open reads as null without a write', () => {
    beginAttempt('u1', 'q1', 'x');
    vi.setSystemTime(new Date(NOW.getTime() + 25 * 3600_000));
    const [set, remove] = spies();
    try {
      expect(getAttempt('u1')).toBeNull();
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      set.mockRestore();
      remove.mockRestore();
    }
  });

  it('the snapshot is the same object on every read (no endless re-render)', () => {
    const { attempt } = beginAttempt('u1', 'q1', 'x');
    const reads = [getAttempt('u1'), getAttempt('u1'), getAttempt('u1')];
    expect(reads.every((read) => read === attempt)).toBe(true);
    expect(getAttempt('nobody')).toBeNull();
    expect(getAttempt('nobody')).toBeNull();
  });
});

describe('reassertAttempt: the doubt must outlive a check that settled nothing', () => {
  it('writes the record back when another tab removed it', () => {
    const { attempt } = beginAttempt('u1', 'q1', 'Telegram Stars');
    // tab A got a clear refusal for its own first send and removed the record
    window.localStorage.removeItem(STORAGE_KEY('u1'));
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY('u1'), newValue: null }));
    expect(getAttempt('u1')).toBeNull();
    reassertAttempt('u1', attempt);
    expect(getAttempt('u1')).toEqual(attempt);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY('u1')) ?? '')).toEqual(attempt);
  });

  it('works even when the cache never heard of the removal (storage is read fresh)', () => {
    const { attempt } = beginAttempt('u1', 'q1', 'x');
    window.localStorage.removeItem(STORAGE_KEY('u1')); // no storage event delivered
    reassertAttempt('u1', attempt);
    expect(window.localStorage.getItem(STORAGE_KEY('u1'))).not.toBeNull();
  });

  it('NEVER overwrites a record of another quote', () => {
    const { attempt } = beginAttempt('u1', 'q1', 'one');
    resolveAttempt('u1', 'q1');
    const other = beginAttempt('u1', 'q2', 'two').attempt;
    reassertAttempt('u1', attempt);
    expect(getAttempt('u1')).toBe(other);
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY('u1')) ?? '') as {
      quoteId: string;
    };
    expect(stored.quoteId).toBe('q2');
  });

  it('leaves a record that is already there alone, and does not revive a stale one', () => {
    const { attempt } = beginAttempt('u1', 'q1', 'x');
    const listener = vi.fn();
    subscribeAttempts(listener);
    reassertAttempt('u1', attempt);
    expect(listener).not.toHaveBeenCalled();
    resolveAttempt('u1', 'q1');
    reassertAttempt('u1', { ...attempt, at: NOW.getTime() - 48 * 3600_000 });
    expect(getAttempt('u1')).toBeNull();
  });
});

describe('beginAttempt reads its own write back (no Web Locks)', () => {
  it('another tab that wrote in the same instant wins: nothing is sent from here', () => {
    const rival = {
      quoteId: 'q_other',
      key: 'rival-key-of-the-other-tab',
      at: NOW.getTime(),
      label: 'Premium',
    };
    const realSet = Storage.prototype.setItem.bind(window.localStorage);
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((name: string, value: string) => {
        realSet(name, value);
        // the other tab's write lands right after ours
        realSet(name, JSON.stringify(rival));
      });
    try {
      const result = beginAttempt('u1', 'q1', 'x');
      expect(result).toMatchObject({ lost: true, retry: true });
      expect(result.attempt).toEqual(rival);
      expect(getAttempt('u1')).toEqual(rival);
    } finally {
      spy.mockRestore();
    }
  });

  it('the same quote with another key is lost too', () => {
    const rival = {
      quoteId: 'q1',
      key: 'rival-key-of-the-other-tab',
      at: NOW.getTime(),
      label: 'x',
    };
    const realSet = Storage.prototype.setItem.bind(window.localStorage);
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((name: string, value: string) => {
        realSet(name, value);
        // the other tab's write lands right after ours
        realSet(name, JSON.stringify(rival));
      });
    try {
      expect(beginAttempt('u1', 'q1', 'x')).toMatchObject({ lost: true });
    } finally {
      spy.mockRestore();
    }
  });

  it('an undisturbed write is not lost', () => {
    expect(beginAttempt('u1', 'q1', 'x')).toMatchObject({ lost: false, retry: false });
  });
});

describe('syncFromStorage', () => {
  it('takes over what another tab wrote, even without a storage event', () => {
    getAttempt('u1');
    const listener = vi.fn();
    subscribeAttempts(listener);
    const record = { quoteId: 'q7', key: KEY, at: NOW.getTime(), label: 'x' };
    window.localStorage.setItem(STORAGE_KEY('u1'), JSON.stringify(record));
    syncFromStorage('u1');
    expect(getAttempt('u1')).toEqual(record);
    expect(listener).toHaveBeenCalledTimes(1);
    syncFromStorage('u1');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('leaves the in-memory record alone when storage cannot be read', () => {
    const { attempt } = beginAttempt('u1', 'q1', 'x');
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      syncFromStorage('u1');
      expect(getAttempt('u1')).toBe(attempt);
    } finally {
      spy.mockRestore();
    }
  });
});
