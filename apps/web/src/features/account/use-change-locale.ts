'use client';

import type { Locale, Me } from '@repo/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { switchLocalePath } from '../../i18n/locale-path';
import { updateMe } from '../../lib/api/me';
import { hardNavigate } from '../../lib/navigation';
import { qk } from '../../lib/query-keys';
import { useTgUiStore } from '../../stores/tg-ui-store';

// One lock for the whole page. The profile picker, the header switch and the account-menu switch
// are separate hook instances mounted at the same time; a lock per instance would let a fast press
// on two of them save twice and navigate twice. A module-level flag is set synchronously (a hook
// state or `useIsMutating` would only change after the next render) and read by every instance.
let locked = false;
const listeners = new Set<() => void>();
function setLocked(next: boolean): void {
  locked = next;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Opens the lock again. It stays closed through a page load on purpose (the old page must not take
 * a second choice while the new one is coming), so it is opened here when the page is shown from
 * the back/forward cache, and by tests between cases.
 */
export function releaseLocaleLock(): void {
  setLocked(false);
}

export interface ChangeLocale {
  /** Ask for another language. Ignored while a change is running (also in the same tick). */
  change: (locale: Locale) => void;
  /**
   * Some switch on the page is saving, or the page is already loading in the new language: a
   * second press, on this switch or another, does nothing.
   */
  busy: boolean;
  /** The server did not save the choice; nothing was changed. */
  failed: boolean;
  reset: () => void;
}

/**
 * The one way the app changes its language, for the profile picker and the store header switch.
 *
 * A signed-in user's choice is a profile setting: it is saved first (`PATCH /me { locale }`, a real
 * endpoint) and only then applied, so the bot, the Mini App and the website agree. The save is
 * made when the choice differs from `me.locale`, NOT from the language on screen: the page may be
 * in Russian (a /ru link) while the profile still says Uzbek. A guest (no `/me` in the cache) only
 * changes the page language.
 *
 * Applying: the Mini App has no locale in its URL and switches its own state; the web store loads
 * the same page under the other prefix (the catalogs of a language travel with the page), unless
 * the URL already matches. A failure leaves everything as it was.
 */
export function useChangeLocale(variant: 'tg' | 'web'): ChangeLocale {
  const client = useQueryClient();
  const pathname = usePathname();
  const onScreen = useLocale();
  const setTgLocale = useTgUiStore((state) => state.setLocale);
  const busy = useSyncExternalStore(
    subscribe,
    () => locked,
    () => false,
  );

  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) releaseLocaleLock();
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  const mutation = useMutation({
    mutationFn: async (target: Locale) => {
      const me = client.getQueryData<Me>(qk.me());
      if (me === undefined || me.locale === target) return;
      client.setQueryData(qk.me(), await updateMe({ locale: target }));
    },
    onSuccess: (_, target) => {
      if (variant === 'tg') {
        setTgLocale(target);
        setLocked(false);
      } else if (onScreen === target) {
        setLocked(false);
      } else {
        // Stays locked through the page load.
        hardNavigate(switchLocalePath(pathname, window.location.search, target));
      }
    },
    onError: () => {
      setLocked(false);
    },
  });

  const { mutate, reset } = mutation;
  const change = useCallback(
    (target: Locale) => {
      if (locked) return;
      const me = client.getQueryData<Me>(qk.me());
      const savedAlready = me === undefined || me.locale === target;
      if (target === onScreen && savedAlready) return;
      setLocked(true);
      mutate(target);
    },
    [client, mutate, onScreen],
  );

  // A failure message is not left on screen for good.
  const failed = mutation.isError;
  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(reset, 8000);
    return () => clearTimeout(timer);
  }, [failed, reset]);

  return { change, busy, failed, reset };
}
