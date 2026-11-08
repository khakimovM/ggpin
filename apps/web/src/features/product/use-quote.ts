'use client';

import type { CreateQuoteBody, QuoteResponse } from '@repo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { isApiError } from '../../lib/api/errors';
import { createQuote } from '../../lib/api/quotes';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { qk } from '../../lib/query-keys';
import { useCountdown } from '../auth/use-countdown';
import { retryDelaySec } from './retry-delay';

/** What the visitor picked: a ready package, or a free quantity. */
export type Selection = { kind: 'sku'; skuId: string } | { kind: 'qty'; quantity: number };

export const QUOTE_DEBOUNCE_MS = 500;

export type QuoteView =
  /** Nothing to price yet (no confirmed recipient, no package). */
  | { status: 'idle' }
  /** The quantity is still being typed, or the request is on its way. */
  | { status: 'pending' }
  /** The server's price. `expired` once `expiresAt` passed: it is never renewed on its own. */
  | { status: 'ready'; quote: QuoteResponse; msLeft: number; expired: boolean }
  /** 503 PRICE_UNAVAILABLE: no fresh rate or cost. Retried by the visitor. */
  | { status: 'unavailable' }
  /** 429: the request is repeated by itself after `retryInSec` (a live countdown). */
  | { status: 'rateLimited'; retryInSec: number }
  /** 422 RECIPIENT_INVALID: the recipient token is dead (it lives 10 minutes). Ask for it again. */
  | { status: 'recipientInvalid' }
  /** 422 QTY_OUT_OF_RANGE / PRODUCT_UNAVAILABLE: the catalog moved on. `at` stamps this answer. */
  | { status: 'productChanged'; at: number }
  | { status: 'failed' };

export interface QuoteControls {
  view: QuoteView;
  /** A new quote for the same choice (expired price, 503, network). */
  refresh: () => void;
  /**
   * Drops the cached answer for the current request. Used when the answer is known to be dead (a
   * recipient token the server refused): the same request asked again later, e.g. when a new lookup
   * returns the same token, must reach the server and not meet the old error.
   */
  discard: () => void;
}

/**
 * `POST /quotes`: the only source of a price the visitor pays. Nothing is computed here: the
 * server's `priceTiyin` / `totalTiyin` strings are shown as they come. A quantity is debounced
 * (500 ms) and a request that a newer choice overtakes is aborted (the signal reaches fetch). A
 * quote is not refetched in the background (each one is a server record); an expired one waits
 * for the visitor to press "Narxni yangilash".
 */
export function useQuote(
  productId: string,
  recipientToken: string | null,
  selection: Selection | null,
): QuoteControls {
  const typedQty = selection?.kind === 'qty' ? selection.quantity : null;
  const settledQty = useDebouncedValue(typedQty, QUOTE_DEBOUNCE_MS, (value) => value === null);
  const settling = typedQty !== settledQty;

  // Primitives, not the `selection` object: a new object with the same choice must not rebuild
  // the request.
  const skuId = selection?.kind === 'sku' ? selection.skuId : null;
  const body = useMemo<CreateQuoteBody | null>(() => {
    if (recipientToken === null) return null;
    if (skuId !== null) return { productId, skuId, recipientToken };
    return settledQty === null ? null : { productId, quantity: settledQty, recipientToken };
  }, [productId, recipientToken, skuId, settledQty]);

  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => qk.quote(body ?? { productId, recipientToken: '', quantity: 1 }),
    [body, productId],
  );
  const discard = useCallback(
    () => void queryClient.removeQueries({ queryKey, exact: true }),
    [queryClient, queryKey],
  );
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => {
      if (body === null) throw new Error('no quote request');
      return createQuote(body, signal);
    },
    enabled: body !== null && !settling,
    // 'static', not a long time: a FAILED refetch marks the query invalidated, and an invalidated
    // query counts as stale however long the stale time is, so coming back to it (another package,
    // then this one) would ask the server at once. A cached answer is shown as it is: an old quote
    // stays old until the visitor renews it, and a 429 waits out its Retry-After.
    staleTime: 'static',
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const { refetch } = query;
  const refresh = () => void refetch();

  // A 429 repeats the request by itself. The timer hangs on `errorUpdatedAt`, which changes with
  // EVERY failed answer: a second 429 with the same Retry-After must arm a new timer too (the error
  // object and the delay are the same then, and a query that already holds a quote keeps its error
  // until a request succeeds).
  const error = query.isError ? query.error : null;
  const retryMs =
    isApiError(error) && error.code === 'RATE_LIMITED'
      ? retryDelaySec(error.retryAfterSec) * 1000
      : null;
  const errorAt = query.errorUpdatedAt;
  useEffect(() => {
    if (retryMs === null) return;
    // The wait that is LEFT: coming back to a cached 429 must not wait the full delay again (the
    // countdown on screen counts from the answer, not from the return). Read in the effect, not
    // in render.
    const left = Math.max(0, errorAt + retryMs - Date.now());
    const timer = setTimeout(() => void refetch(), left);
    return () => clearTimeout(timer);
  }, [errorAt, retryMs, refetch]);
  const retryLeftMs = useCountdown(retryMs === null ? null : errorAt + retryMs, errorAt);

  const quote = query.data;
  const deadline = quote ? Date.parse(quote.expiresAt) : null;
  // The quote cannot have expired before it arrived: `dataUpdatedAt` keeps the first frame right.
  const msLeft = useCountdown(Number.isNaN(deadline) ? null : deadline, query.dataUpdatedAt);

  const view = deriveView({
    idle: body === null && !settling,
    busy: settling || query.isFetching,
    retryLeftMs: retryMs === null ? null : retryLeftMs,
    error,
    errorAt,
    quote,
    msLeft,
  });
  return { view, refresh, discard };
}

interface ViewInput {
  idle: boolean;
  busy: boolean;
  retryLeftMs: number | null;
  error: Error | null;
  errorAt: number;
  quote: QuoteResponse | undefined;
  msLeft: number;
}

function deriveView({
  idle,
  busy,
  retryLeftMs,
  error,
  errorAt,
  quote,
  msLeft,
}: ViewInput): QuoteView {
  if (idle) return { status: 'idle' };
  if (busy) return { status: 'pending' };
  if (retryLeftMs !== null) {
    return { status: 'rateLimited', retryInSec: Math.max(1, Math.ceil(retryLeftMs / 1000)) };
  }
  if (error !== null) return errorView(error, errorAt);
  if (quote === undefined) return { status: 'pending' };
  return { status: 'ready', quote, msLeft, expired: msLeft <= 0 };
}

function errorView(error: Error, at: number): QuoteView {
  if (!isApiError(error)) return { status: 'failed' };
  switch (error.code) {
    case 'PRICE_UNAVAILABLE':
      return { status: 'unavailable' };
    case 'RECIPIENT_INVALID':
      return { status: 'recipientInvalid' };
    case 'QTY_OUT_OF_RANGE':
    case 'PRODUCT_UNAVAILABLE':
      return { status: 'productChanged', at };
    default:
      return { status: 'failed' };
  }
}
