'use client';

import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useCatalogSearchStore } from '../../stores/catalog-search-store';
import { sanitizeSearch } from './catalog-query';

export const SEARCH_DEBOUNCE_MS = 300;

export interface CatalogSearch {
  /** What is in the box, as typed. */
  text: string;
  setText: (text: string) => void;
  clear: () => void;
  /**
   * What the catalog is asked for: sanitised (trimmed, at most 64 characters) and delayed by
   * 300 ms after the last keystroke. Empty means no search. Clearing applies at once.
   */
  query: string;
}

export function useCatalogSearch(): CatalogSearch {
  const text = useCatalogSearchStore((state) => state.text);
  const setText = useCatalogSearchStore((state) => state.setText);
  const clear = useCatalogSearchStore((state) => state.clear);
  const sanitised = sanitizeSearch(text);
  // An emptied box applies at once and resets the delay: no stale results for 300 ms.
  const query = useDebouncedValue(sanitised, SEARCH_DEBOUNCE_MS, (value) => value === '');
  return { text, setText, clear, query };
}
