import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCatalogSearchStore } from '../../../stores/catalog-search-store';
import { SEARCH_DEBOUNCE_MS, useCatalogSearch } from '../use-catalog-search';

describe('useCatalogSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCatalogSearchStore.setState({ text: '' });
  });
  afterEach(() => vi.useRealTimers());

  it('the query follows the text only after 300 ms, trimmed', () => {
    const { result } = renderHook(() => useCatalogSearch());
    act(() => {
      result.current.setText('  pubg  ');
    });
    expect(result.current.text).toBe('  pubg  ');
    expect(result.current.query).toBe('');
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(result.current.query).toBe('');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.query).toBe('pubg');
  });

  it('several keystrokes, one query', () => {
    const { result } = renderHook(() => useCatalogSearch());
    const queries: string[] = [];
    for (const text of ['p', 'pu', 'pub', 'pubg']) {
      act(() => {
        result.current.setText(text);
      });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      queries.push(result.current.query);
    }
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    queries.push(result.current.query);
    expect(queries).toEqual(['', '', '', '', 'pubg']);
  });

  it('whitespace only is no search', () => {
    const { result } = renderHook(() => useCatalogSearch());
    act(() => {
      result.current.setText('     ');
    });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(result.current.query).toBe('');
  });

  it('a long text is cut to 64 characters', () => {
    const { result } = renderHook(() => useCatalogSearch());
    act(() => {
      result.current.setText('x'.repeat(200));
    });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(result.current.query).toHaveLength(64);
  });

  it('clearing empties the query at once, without waiting', () => {
    const { result } = renderHook(() => useCatalogSearch());
    act(() => {
      result.current.setText('steam');
    });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(result.current.query).toBe('steam');
    act(() => {
      result.current.clear();
    });
    expect(result.current.text).toBe('');
    expect(result.current.query).toBe('');
  });

  it('after clearing, the next letters do not bring the old results back for 300 ms', () => {
    const { result } = renderHook(() => useCatalogSearch());
    act(() => {
      result.current.setText('pubg');
    });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(result.current.query).toBe('pubg');

    act(() => {
      result.current.clear();
    });
    act(() => {
      result.current.setText('p');
    });
    // The old "pubg" must not reappear while "p" is still settling.
    expect(result.current.query).toBe('');
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(result.current.query).toBe('');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.query).toBe('p');
  });

  it('two users of the hook (the box and the catalog) see the same text', () => {
    const box = renderHook(() => useCatalogSearch());
    const catalog = renderHook(() => useCatalogSearch());
    act(() => {
      box.result.current.setText('roblox');
    });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(catalog.result.current.query).toBe('roblox');
  });
});
