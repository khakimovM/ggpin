'use client';

import { useSyncExternalStore } from 'react';

const subscribe = (): (() => void) => () => {};

/**
 * False in the server HTML and during hydration, true once React has hydrated (and at once for a
 * component first rendered on the client). React renders the server snapshot while hydrating and
 * switches to the client one right after, so this is the real "the handlers are attached" signal:
 * a button rendered before it would look ready while a click on it is lost. (The same as a
 * `mounted` flag set in an effect, without a setState inside the effect.)
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
