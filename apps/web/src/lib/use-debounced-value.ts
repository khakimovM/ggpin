'use client';

import { useEffect, useState } from 'react';

/**
 * `value`, delayed: it changes `delayMs` after the last change of its input, so a search box
 * typed into quickly makes one request, not one per key. The first value is available at once.
 *
 * `immediate` names the values that must not wait (an emptied search box): for those the output
 * follows the input in the same render, and, because the output then really IS that value, the
 * next typed value starts from it. Without that, clearing "pubg" and typing "p" would show the
 * old "pubg" results for another 300 ms.
 */
export function useDebouncedValue<T>(
  value: T,
  delayMs: number,
  immediate?: (value: T) => boolean,
): T {
  const [debounced, setDebounced] = useState(value);
  // Adjusting state while rendering (the documented pattern): React re-renders at once.
  if (immediate?.(value) && debounced !== value) setDebounced(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return immediate?.(value) ? value : debounced;
}
