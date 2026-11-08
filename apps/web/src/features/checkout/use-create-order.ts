'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { createOrder } from '../../lib/api/orders';
import { withAttemptLock } from '../../lib/attempt-lock';
import {
  beginAttempt,
  forgetKey,
  getAttempt,
  reassertAttempt,
  resolveAttempt,
  subscribeAttempts,
  syncFromStorage,
  type OrderAttempt,
} from '../../lib/order-attempts';
import { qk } from '../../lib/query-keys';
import { haptics } from '../../telegram/haptics';
import { classifyOrderError, resolvesAttempt, type Channel, type PayOutcome } from './pay-outcome';

export interface CreateOrderControls {
  /**
   * Pays for one quote. `label` is the product and variant the visitor saw (kept with the
   * write-ahead record so a later visit can say WHICH purchase is in doubt). Pressed twice while
   * it runs, it is still ONE request.
   */
  pay: (quoteId: string, label: string) => Promise<PayOutcome>;
  paying: boolean;
}

/** The purchase of this user whose result is unknown, if any (survives a remount, reload, other tab). */
export function useUncertainOrder(userId: string | null): OrderAttempt | null {
  return useSyncExternalStore(
    subscribeAttempts,
    () => (userId === null ? null : getAttempt(userId)),
    () => null,
  );
}

/**
 * `POST /orders` with its `Idempotency-Key`. The attempt is written down BEFORE the request leaves
 * (order-attempts.ts), so whatever happens to the page afterwards the next visit finds it and asks
 * again with the SAME quote and key: the server then returns the order it may already have made.
 * While a record is unresolved no OTHER quote is paid. Which answers end the doubt is decided in
 * pay-outcome.ts (`resolvesAttempt`). Keys are made in the press handler, not in render.
 */
export function useCreateOrder(userId: string | null, channel: Channel): CreateOrderControls {
  const queryClient = useQueryClient();
  const running = useRef<Promise<PayOutcome> | null>(null);
  const mutation = useMutation({
    mutationFn: ({ quoteId, key }: { quoteId: string; key: string }) =>
      createOrder({ quoteId }, key),
  });
  const { mutateAsync } = mutation;

  const refreshMoney = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.wallet.all }),
        queryClient.invalidateQueries({ queryKey: qk.orders.all }),
      ]),
    [queryClient],
  );

  // The whole chain - read the slot FRESH from storage, write the record, send, settle - runs under
  // the user's purchase lock, so two windows cannot interleave in it.
  const attemptPayment = useCallback(
    async (userId: string, quoteId: string, label: string): Promise<PayOutcome> => {
      syncFromStorage(userId);
      // Another purchase is still in doubt: it is settled first, never paid around.
      const pending = getAttempt(userId);
      if (pending !== null && pending.quoteId !== quoteId) {
        return { kind: 'uncertain', quoteId: pending.quoteId };
      }
      // Written BEFORE the request goes out.
      const { attempt, retry, lost } = beginAttempt(userId, quoteId, label);
      // Another window wrote its record in the same instant: nothing is sent from here.
      if (lost) return { kind: 'uncertain', quoteId: attempt.quoteId };
      try {
        const { order } = await mutateAsync({ quoteId, key: attempt.key });
        resolveAttempt(userId, quoteId);
        forgetKey(quoteId);
        // Not awaited: a refetch that hangs (there is no timeout on a GET) must not hold the paid
        // order back from its page.
        void refreshMoney();
        haptics.success();
        return { kind: 'ok', orderId: order.id };
      } catch (error) {
        let outcome = classifyOrderError(error, quoteId);
        const resolved = resolvesAttempt(error, outcome, channel, retry);
        // "No such quote" that does not settle the doubt (a 404 on the web can be the CSRF guard) is
        // not news about the order: the purchase is still unknown.
        if (!resolved && outcome.kind === 'expired') outcome = { kind: 'uncertain', quoteId };
        if (resolved) {
          resolveAttempt(userId, quoteId);
          // No order for this quote: its key is spent, the next quote gets a new one.
          if (outcome.kind === 'expired') forgetKey(quoteId);
          if (outcome.kind === 'ok') void refreshMoney();
        } else {
          // The doubt stands, so the record must too: another window may have removed it meanwhile
          // (its own first send was refused clearly). Only an empty slot is written back.
          reassertAttempt(userId, attempt);
          // The money may have moved: the wallet and the order list must be read again.
          if (outcome.kind === 'uncertain') void refreshMoney();
        }
        if (outcome.kind === 'ok') haptics.success();
        else haptics.error();
        return outcome;
      }
    },
    [channel, mutateAsync, refreshMoney],
  );

  const pay = useCallback(
    (quoteId: string, label: string): Promise<PayOutcome> => {
      // A second press while the first is on its way is the same payment, not another one.
      if (running.current !== null) return running.current;
      // No signed-in user, no purchase: the record is kept per user.
      if (userId === null) return Promise.resolve({ kind: 'failed', code: 'UNAUTHORIZED' });
      const run = withAttemptLock<PayOutcome>(
        userId,
        () => attemptPayment(userId, quoteId, label),
        () => {
          // A payment is on its way in another window: show its record, send nothing.
          syncFromStorage(userId);
          return { kind: 'busy' };
        },
      ).finally(() => {
        running.current = null;
      });
      running.current = run;
      return run;
    },
    [attemptPayment, userId],
  );

  return { pay, paying: mutation.isPending };
}
