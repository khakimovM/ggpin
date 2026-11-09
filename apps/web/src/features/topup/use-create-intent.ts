'use client';

import { somToTiyin, type CardBank } from '@repo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { createTopupIntent } from '../../lib/api/payments';
import { createIdempotencyKey } from '../../lib/idempotency';
import { useCountdown } from '../auth/use-countdown';
import { qk } from '../../lib/query-keys';
import { classifyCreateError, type CreateOutcome } from './topup-outcome';

/**
 * `created` carries only what the next step needs. The pay link (`redirectUrl`) holds the
 * capability token: it is handed to the caller once and is never put into a query or mutation cache
 * (X3), a state, or a log.
 */
export type CreateResult =
  { kind: 'created'; intentId: string; redirectUrl: string } | CreateOutcome;

export interface CreateIntentControls {
  /** null when a request is already on its way (a double press is one request). */
  create: (amountSom: string, bank: CardBank | undefined) => Promise<CreateResult | null>;
  creating: boolean;
  /** Milliseconds left of a 429's `Retry-After`; the button stays off for that long. */
  waitMs: number;
}

/**
 * `POST /payments/intents` with one `Idempotency-Key` per body. It is NEVER sent twice by itself
 * (no retry, not even after a network error): the visitor presses again, and the same body then
 * carries the same key, so the server answers with the request it may already have made instead of
 * a second one. A different amount or bank is a different body and gets a new key.
 */
export function useCreateIntent(): CreateIntentControls {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [cooldown, setCooldown] = useState<{ until: number; from: number } | null>(null);
  const waitMs = useCountdown(cooldown?.until ?? null, cooldown?.from ?? 0);
  const running = useRef(false);
  const keyed = useRef<{ body: string; key: string } | null>(null);

  const create = useCallback(
    async (amountSom: string, bank: CardBank | undefined): Promise<CreateResult | null> => {
      if (running.current) return null;
      const amountTiyin = somToTiyin(amountSom).toString();
      const body = `${amountTiyin}:${bank ?? 'auto'}`;
      if (keyed.current?.body !== body) keyed.current = { body, key: createIdempotencyKey() };
      const { key } = keyed.current;
      running.current = true;
      setCreating(true);
      try {
        const created = await createTopupIntent(
          { provider: 'P2P_CARD', amountTiyin, purpose: 'TOPUP', ...(bank ? { bank } : {}) },
          key,
        );
        keyed.current = null;
        // Stale, not refetched now: the form that is closing must not flash its "unfinished payment"
        // sheet; the home pill and the waiting screen ask again when they open.
        void queryClient.invalidateQueries({ queryKey: qk.payments.all, refetchType: 'none' });
        return { kind: 'created', intentId: created.intentId, redirectUrl: created.redirectUrl };
      } catch (error) {
        const outcome = classifyCreateError(error);
        if (outcome.kind === 'rate' && outcome.retryAfterSec !== undefined) {
          const from = Date.now();
          setCooldown({ from, until: from + outcome.retryAfterSec * 1000 });
        }
        // A definite answer about THIS body ends its key; a lost answer keeps it for the retry.
        if (outcome.kind !== 'failed' && outcome.kind !== 'rate') keyed.current = null;
        return outcome;
      } finally {
        running.current = false;
        setCreating(false);
      }
    },
    [queryClient],
  );

  return { create, creating, waitMs };
}
