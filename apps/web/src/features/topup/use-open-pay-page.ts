'use client';

import type { TopupIntent } from '@repo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { cancelTopupIntent, createPayLink } from '../../lib/api/payments';
import { qk } from '../../lib/query-keys';
import { haptics } from '../../telegram/haptics';
import { openLink, resolveSiteUrl } from '../../telegram/open-link';
import { PENDING_FILTER } from './use-intent-status';

/**
 * Opens the payment page of a request in the external browser. The link carries the capability
 * token, so it lives in this hook's scope only (a ref: never a cache, a state, storage or a log).
 *
 * Some clients refuse `openLink` once an `await` has passed since the tap. When the client refuses
 * a link of ours, the link stays here and `held` turns true: the screen then offers a button whose
 * press calls `openHeld`, which calls `openLink` synchronously inside the tap. A link of another
 * origin is never kept: nothing is opened for it.
 */
export function useOpenPayPage() {
  const [opening, setOpening] = useState(false);
  const [held, setHeld] = useState(false);
  const link = useRef<string | null>(null);
  const running = useRef(false);

  const hold = useCallback((url: string): boolean => {
    if (resolveSiteUrl(url) === null) return false;
    link.current = url;
    setHeld(true);
    return true;
  }, []);

  const drop = useCallback(() => {
    link.current = null;
    setHeld(false);
  }, []);

  /** Asks for a FRESH link (the old one stops working) and opens it. null = a press already runs. */
  const open = useCallback(
    async (intentId: string): Promise<boolean | null> => {
      if (running.current) return null;
      running.current = true;
      setOpening(true);
      drop();
      try {
        const { redirectUrl } = await createPayLink(intentId);
        if (openLink(redirectUrl)) return true;
        haptics.error();
        hold(redirectUrl);
        return false;
      } catch {
        haptics.error();
        return false;
      } finally {
        running.current = false;
        setOpening(false);
      }
    },
    [drop, hold],
  );

  /** Called straight from a tap: no `await` between the tap and `openLink`. */
  const openHeld = useCallback((): boolean => {
    const url = link.current;
    if (url === null) return false;
    const opened = openLink(url);
    if (opened) drop();
    else haptics.error();
    return opened;
  }, [drop]);

  return { open, opening, held, hold, openHeld, drop };
}

/**
 * `POST /payments/intents/:id/cancel`. On success the cache is written AT ONCE (the request reads
 * CANCELLED, with no card, and no request is waiting) so a stale answer can never show the old card
 * number again; then everything about payments is asked for again.
 */
export function useCancelIntent() {
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const running = useRef(false);
  const cancel = useCallback(
    async (intentId: string): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;
      setCancelling(true);
      try {
        await cancelTopupIntent(intentId);
        queryClient.setQueryData<TopupIntent>(qk.payments.intent(intentId), (intent) =>
          intent === undefined ? intent : { ...intent, status: 'CANCELLED', card: null },
        );
        queryClient.setQueryData<TopupIntent | null>(qk.payments.intents(PENDING_FILTER), null);
        await queryClient.invalidateQueries({ queryKey: qk.payments.all });
        return true;
      } catch {
        haptics.error();
        return false;
      } finally {
        running.current = false;
        setCancelling(false);
      }
    },
    [queryClient],
  );
  return { cancel, cancelling };
}
