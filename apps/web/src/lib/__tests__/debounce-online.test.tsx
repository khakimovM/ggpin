import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedValue } from '../use-debounced-value';
import { useOnline } from '../use-online';

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives the first value at once', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 300));
    expect(result.current).toBe('a');
  });

  it('changes only 300 ms after the last change', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: 'p' },
    });
    rerender({ value: 'pu' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: 'pub' });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe('p');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('pub');
  });

  it('a burst of changes produces one change of the output', () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: '' },
    });
    for (const value of ['p', 'pu', 'pub', 'pubg']) {
      rerender({ value });
      act(() => {
        vi.advanceTimersByTime(50);
      });
      seen.push(result.current);
    }
    act(() => {
      vi.advanceTimersByTime(300);
    });
    seen.push(result.current);
    expect(seen).toEqual(['', '', '', '', 'pubg']);
  });

  it('an immediate value skips the wait, and the next value starts from it', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300, (v) => v === ''),
      { initialProps: { value: '' } },
    );
    rerender({ value: 'pubg' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe('pubg');
    rerender({ value: '' });
    expect(result.current).toBe('');
    rerender({ value: 'p' });
    expect(result.current).toBe('');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe('p');
  });

  it('does not fire after the component is gone', () => {
    const { unmount } = renderHook(() => useDebouncedValue('a', 300));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useOnline', () => {
  afterEach(() => vi.restoreAllMocks());

  it('follows the browser online and offline events', () => {
    const state = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);

    state.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current).toBe(false);

    state.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
  });
});
