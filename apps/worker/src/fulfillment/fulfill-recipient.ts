import { RecipientCheckResultSchema } from '@repo/shared';
import {
  ADAPTER_CALL_TIMEOUT_MS,
  type FulfillmentAdapter,
  type ProductRef,
} from '../adapters/fulfillment-adapter';
import { namespacedProviderRef, parseProviderRef } from '../adapters/provider-ref';

// Whose recipient handle an attempt uses (phase 5 S7, S3b review CR #2; D-62 candidate).
//
// The order's providerRef is `<ISSUER>:<issuer's handle>` (provider-ref.ts):
//
// - issuer = the picked adapter -> its own handle; `prepare` compares it, as before.
// - issuer differs (the issuer is DOWN or gone, so the router picked another route, or the order's
//   attempts stay on another adapter) -> the picked adapter checks the recipient again, before any
//   value moves: FOUND with the same display name the customer confirmed -> that adapter's handle
//   is used (and kept on the attempt as `recheckedProviderRef`); NOT_FOUND or another name ->
//   RECIPIENT_CHANGED (FAILED + REFUND: nothing was sent, there is no attempt yet); UNAVAILABLE, a
//   throw, a timeout or an answer that does not parse -> a throw (the job retries; on the last try
//   the order is HELD, ADAPTER_ERROR). Never a payment to an unchecked handle.
// - the display name is a heuristic, NOT an identifier: two adapters share no id space, so the
//   name the customer saw is the only thing both can be compared on. It is compared after Unicode
//   NFC, trimming and collapsing inner whitespace (one provider's "Aziz  K" is another's "Aziz K").
//   Because a name can move to another account over time (a username released and taken), a
//   name-only match is trusted only while the confirmation is fresh: an order created more than
//   RECHECK_MAX_AGE_MS ago (a HELD order reopened hours later by `order:retry`) is STALE -> HELD
//   for an operator, and the provider is not even asked (S7 review m3, audit L-1, D-62).
// - no namespace (written before S7) -> the stored handle unchanged, as before S7.

/**
 * How old an order's recipient confirmation may be for a name-only re-check by another adapter.
 * The customer confirmed the name at quote time (a quote lives 10 minutes) and a normal order is
 * fulfilled seconds after payment; the fulfill queue's own retries (5 tries, exponential from 5 s)
 * end within about 75 s. Thirty minutes covers all of that with room for a queue backlog, and
 * refuses what it is meant to refuse: an order HELD for hours and then retried, whose username may
 * belong to someone else by now. A constant, not an env (no new configuration in this slice).
 */
export const RECHECK_MAX_AGE_MS = 30 * 60_000;

/**
 * How far the order's createdAt (stamped by the DATABASE clock) may lie in the worker's future
 * before the age is distrusted (S7 audit N-2): a worker clock running behind the database would
 * make every order look young, and a name-only re-check would then never be refused. Small skew
 * between hosts is normal; more than this is a broken clock, and the re-check is refused (STALE,
 * HELD for an operator) rather than trusted. A constant, not an env.
 */
export const RECHECK_CLOCK_TOLERANCE_MS = 5 * 60_000;

/** The key of the re-checked handle in `FulfillmentAttempt.request`. */
export const RECHECKED_REF_KEY = 'recheckedProviderRef';

export class RecipientRecheckError extends Error {
  constructor(readonly reason: 'UNAVAILABLE' | 'BAD_ANSWER' | 'TIMEOUT') {
    super(`the recipient could not be checked again (${reason})`);
    this.name = 'RecipientRecheckError';
  }
}

export type RecipientDecision =
  | {
      readonly kind: 'USE';
      /** The picked adapter's own handle (what its prepare/send compare). */
      readonly providerRef: string;
      /** Set when it came from a re-check: the namespaced handle kept on the attempt. */
      readonly recheckedRef: string | null;
    }
  | { readonly kind: 'CHANGED' }
  /** A re-check was needed but the confirmation is too old for a name-only match: HELD. */
  | { readonly kind: 'STALE' };

export interface StoredRecipient {
  readonly fields: Readonly<Record<string, string>>;
  readonly providerRef: string;
  /** When the customer confirmed this recipient: the order's createdAt. */
  readonly confirmedAt: Date;
}

export interface RecheckOptions {
  readonly timeoutMs?: number;
  /** The clock (tests). */
  readonly now?: Date;
}

/** The input fields of a stored recipient: what the customer typed, not what we resolved. */
export function inputOf(fields: Readonly<Record<string, string>>): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key !== 'displayName' && key !== 'photoUrl') input[key] = value;
  }
  return input;
}

/** A display name as compared: NFC, inner whitespace runs collapsed to one space, trimmed. */
export function comparableName(name: string): string {
  return name.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

const sameName = (a: string | undefined, b: string): boolean =>
  a !== undefined && comparableName(a) === comparableName(b);

function timeoutAfter(ms: number, signal: AbortSignal): Promise<'TIMEOUT'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMEOUT'), ms);
    timer.unref();
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  });
}

export async function recipientFor(
  adapter: FulfillmentAdapter,
  product: ProductRef,
  stored: StoredRecipient,
  options: RecheckOptions = {},
): Promise<RecipientDecision> {
  const origin = parseProviderRef(stored.providerRef);
  if (origin === null) return { kind: 'USE', providerRef: stored.providerRef, recheckedRef: null };
  if (origin.adapter === adapter.code) {
    return { kind: 'USE', providerRef: origin.ref, recheckedRef: null };
  }
  const ageMs = (options.now?.getTime() ?? Date.now()) - stored.confirmedAt.getTime();
  if (ageMs > RECHECK_MAX_AGE_MS) return { kind: 'STALE' };
  if (ageMs < -RECHECK_CLOCK_TOLERANCE_MS) return { kind: 'STALE' };
  const timeoutMs = options.timeoutMs ?? ADAPTER_CALL_TIMEOUT_MS;
  const controller = new AbortController();
  let answer: unknown;
  try {
    answer = await Promise.race([
      adapter.validateRecipient(product, inputOf(stored.fields), controller.signal),
      timeoutAfter(timeoutMs, controller.signal),
    ]);
  } catch {
    throw new RecipientRecheckError('UNAVAILABLE');
  } finally {
    controller.abort();
  }
  if (answer === 'TIMEOUT') throw new RecipientRecheckError('TIMEOUT');
  const parsed = RecipientCheckResultSchema.safeParse(answer);
  if (!parsed.success) throw new RecipientRecheckError('BAD_ANSWER');
  const result = parsed.data;
  if (result.status === 'UNAVAILABLE') throw new RecipientRecheckError('UNAVAILABLE');
  if (result.status === 'NOT_FOUND') return { kind: 'CHANGED' };
  if (!sameName(stored.fields['displayName'], result.displayName)) return { kind: 'CHANGED' };
  let recheckedRef: string;
  try {
    recheckedRef = namespacedProviderRef(adapter.code, result.providerRef);
  } catch {
    throw new RecipientRecheckError('BAD_ANSWER');
  }
  return { kind: 'USE', providerRef: result.providerRef, recheckedRef };
}

/**
 * The handle an EXISTING attempt of `adapterCode` used (the follow path never re-checks): its
 * issuer's own handle when the issuer is that adapter, else the one its re-check kept on the
 * attempt, else (no namespace, or nothing kept) the stored handle unchanged.
 */
export function attemptProviderRef(
  storedRef: string | null,
  adapterCode: string,
  attemptRequest: unknown,
): string | null {
  if (storedRef === null) return null;
  const origin = parseProviderRef(storedRef);
  if (origin === null) return storedRef;
  if (origin.adapter === adapterCode) return origin.ref;
  const kept: unknown =
    typeof attemptRequest === 'object' && attemptRequest !== null && !Array.isArray(attemptRequest)
      ? Reflect.get(attemptRequest, RECHECKED_REF_KEY)
      : undefined;
  const parsed = typeof kept === 'string' ? parseProviderRef(kept) : null;
  return parsed !== null && parsed.adapter === adapterCode ? parsed.ref : storedRef;
}
