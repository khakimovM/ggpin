// The contract every fulfillment adapter (Fragment, a reseller, a game supplier, the simulator)
// implements (docs/06 "Adapter interfeysi"). Phase 5 S1: the interface only, no processor and no
// registration yet.
//
// `fulfill` of docs/06 is split in three so that the SENDING row is committed BEFORE any value
// leaves (rules/45-fulfillment.md, step 5):
//
//   prepare  no value moves. Re-checks the recipient, asks the provider what it will cost and
//            how to pay. Safe to repeat: a throw here is retried by the queue.
//   (the processor now checks the ceiling and the limits, and commits FulfillmentAttempt SENDING
//    with `PreparedFulfillment.request` and `externalRef`)
//   send     value may leave. After the SENDING commit nothing may THROW to mean "unknown": the
//            outcome is a result, and anything that is not provably "not sent" is NEEDS_REVIEW.
//   confirm  waits for / looks up the final state of a payout that was sent.
//
// Money is bigint minor units in `costCurrency` (TON nanotons, USDT micro units). The ceiling the
// processor compares `PreparedFulfillment.costMinor` with is the one STORED on the order
// (`StoredCostCeiling`, @repo/shared): an adapter never computes or reads a tolerance.
import type {
  AdapterHealth,
  CostCurrency,
  NeedsReviewProof,
  RecipientCheckResult,
} from '@repo/shared';

/** `ProductRoute.adapter` value: FRAGMENT, RESELLER_STARS, FAZERCARDS... */
export type AdapterCode = string;

/** A JSON-safe value: what `FulfillmentAttempt.request` / `response` can hold. No secrets. */
export type AttemptJson =
  | string
  | number
  | boolean
  | null
  | readonly AttemptJson[]
  | { readonly [key: string]: AttemptJson };

export interface ProductRef {
  readonly id: string;
  readonly slug: string;
}

export interface SkuRef {
  readonly id: string | null;
  /** Units of the product the SKU (or the custom quantity) stands for. */
  readonly quantity: number;
}

/**
 * Who gets the product, as stored on the order. `providerRef` is the handle validation returned.
 * It is `null` only for an order whose quote did not carry one (a gap, never a normal case): such
 * an order cannot be re-checked, so `prepare` MUST answer `RECIPIENT_GONE` for it (use
 * `hasProviderRef`) and the order is failed and refunded before any value moves (audit L4). An
 * adapter never pays "unchecked".
 */
export interface FulfillmentRecipient {
  readonly fields: Readonly<Record<string, string>>;
  readonly providerRef: string | null;
}

/**
 * True when the recipient can be re-checked against the provider (see `FulfillmentRecipient`).
 * Like the shared RecipientProviderRefSchema (`/\S/`): a whitespace-only handle (NBSP included,
 * `trim()` and `\s` remove the same characters) is no handle at all.
 */
export function hasProviderRef(
  recipient: FulfillmentRecipient,
): recipient is FulfillmentRecipient & { readonly providerRef: string } {
  return recipient.providerRef !== null && recipient.providerRef.trim().length > 0;
}

export interface PrepareContext {
  readonly orderId: string;
  readonly attemptNo: number;
  readonly product: ProductRef;
  readonly sku: SkuRef;
  readonly recipient: FulfillmentRecipient;
}

/** What `prepare` hands to the processor: enough to commit SENDING, then to `send`. */
export interface PreparedFulfillment {
  readonly adapter: AdapterCode;
  /** What the provider will charge, in `costCurrency`; compared with the order's stored ceiling. */
  readonly costCurrency: CostCurrency;
  readonly costMinor: bigint;
  /**
   * What goes into `FulfillmentAttempt.request` (no secrets): destination, amount, payload hash,
   * provider request id. Persisted before `send` so a crash leaves the proof of what was meant.
   */
  readonly request: AttemptJson;
  /**
   * The reference of the payout when it is known before sending (the signed TON message hash).
   * Persisted with SENDING; the reconciler looks it up on the chain.
   */
  readonly externalRef: string | null;
}

export type PrepareResult =
  | { readonly status: 'READY'; readonly prepared: PreparedFulfillment }
  /**
   * The recipient is no longer the validated one (providerRef differs), does not exist, or has no
   * providerRef to compare (`hasProviderRef` is false): never paid unchecked.
   */
  | { readonly status: 'RECIPIENT_CHANGED' | 'RECIPIENT_GONE' }
  /** The provider asked for something we refuse (unknown pay address...): HELD, never paid. */
  | { readonly status: 'REFUSED'; readonly reason: string };

export type SendResult =
  /** Handed to the provider / the chain. Not yet confirmed. */
  | { readonly status: 'SENT'; readonly externalRef: string; readonly response?: AttemptJson }
  /**
   * PROVABLY not sent (e.g. refused before signing). The only result that allows FAILED +
   * refund without NEEDS_REVIEW, and only with the proof. The proof says WHAT is proven; WHO
   * vouches for it is decided by whoever passes it to `resolveNeedsReview` (the reconciler or an
   * operator), never by the adapter.
   */
  | { readonly status: 'NOT_SENT'; readonly proof: NeedsReviewProof }
  /** Anything else: a timeout, an unexpected answer. The order goes to NEEDS_REVIEW. */
  | { readonly status: 'UNKNOWN'; readonly detail?: string };

export type ConfirmResult =
  /** Paid out for good. `response` is stored on the attempt. */
  | { readonly status: 'DELIVERED'; readonly response?: AttemptJson }
  /** Not final yet: ask again (or time out into NEEDS_REVIEW). */
  | { readonly status: 'PENDING' }
  /** Provably not paid out (the proof decides FAILED + refund). */
  | { readonly status: 'NOT_SENT'; readonly proof: NeedsReviewProof }
  /** The payout is final but failed on the provider side: conservative, goes to NEEDS_REVIEW. */
  | { readonly status: 'PROVIDER_FAILED'; readonly detail?: string }
  | { readonly status: 'UNKNOWN'; readonly detail?: string };

export interface AdapterBalance {
  readonly currency: CostCurrency;
  readonly amountMinor: bigint;
}

export interface FulfillmentAdapter {
  readonly code: AdapterCode;

  /** `validate-recipient`: who is this input? `UNAVAILABLE` means "could not tell", never "no". */
  validateRecipient(
    product: ProductRef,
    input: Readonly<Record<string, string>>,
  ): Promise<RecipientCheckResult>;

  /** The provider's current price for `quantity` units: what price sync stores as a snapshot. */
  quote(
    product: ProductRef,
    sku: SkuRef,
  ): Promise<{ readonly currency: CostCurrency; readonly costMinor: bigint }>;

  prepare(context: PrepareContext): Promise<PrepareResult>;

  /** Called only after SENDING is committed with `prepared.request`. Must not throw for "unknown". */
  send(context: PrepareContext, prepared: PreparedFulfillment): Promise<SendResult>;

  /** `externalRef` is the one persisted with the attempt; safe to call any number of times. */
  confirm(context: PrepareContext, externalRef: string): Promise<ConfirmResult>;

  getBalance(): Promise<AdapterBalance>;

  /** What the router reads; the worker mirrors it to `adapter:health:<code>` (health-keys.ts). */
  health(): Promise<AdapterHealth>;
}
