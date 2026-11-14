import type { AttemptStatus } from '@repo/db';
import {
  exceedsCostCeiling,
  proofIsOperatorOnly,
  proofJustifies,
  type CostCurrency,
  type NeedsReviewProof,
  type OrderStatusReason,
} from '@repo/shared';
import { Cell } from '@ton/core';
import { z } from 'zod';
import type { PreparedFulfillment } from '../adapters/fulfillment-adapter';
import { TonAddressError, parseOrderPayoutAddress, rawAddress } from '../ton/ton-address';

// Pure decisions of the fulfillment core (plan 6.6), kept apart from the I/O so each rule has a
// unit test of its own.

/**
 * How many send attempts one order gets before it is HELD (ADAPTER_ERROR) instead of trying again.
 * A new attempt is made only after the previous one was PROVEN not sent (a TON transfer EXPIRED,
 * a supplier's NOT_SENT with proof). Two, not more: until the second, independent chain source
 * exists (D-60 (2), S12) an EXPIRED verdict rests on one provider, and a false one would pay twice.
 * One retry covers the usual case (a message that missed its block); a second "not sent" in a row
 * says something is wrong, and a human or the reconciler (release or, after HELD_MAX_AGE, refund,
 * D-56 (4)) decides.
 */
export const MAX_SEND_ATTEMPTS = 2;

/** The TON payment instruction an adapter hands over in `PreparedFulfillment.request.ton`. */
export const TonInstructionSchema = z.strictObject({
  /** Raw or user-friendly; the TON module checks it against FRAGMENT_PAY_ADDRESSES. */
  toAddress: z.string().min(1).max(128),
  /** nanotons, a positive canonical decimal (money travels as strings). */
  amountNano: z.string().regex(/^[1-9][0-9]{0,30}$/),
  /** The message body the payee asked for, a BOC in base64. */
  payloadBoc: z.string().min(1).max(8_192),
});
export type TonInstruction = z.infer<typeof TonInstructionSchema>;

/** The instruction stored in an attempt's `request` (or prepared by an adapter), or null. */
export function tonInstructionOf(request: unknown): TonInstruction | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return null;
  const parsed = TonInstructionSchema.safeParse(Reflect.get(request, 'ton'));
  return parsed.success ? parsed.data : null;
}

/** Orders whose cost currency is TON are paid from the hot wallet (Fragment, D-56). */
export function isTonPaid(currency: CostCurrency): boolean {
  return currency === 'TON';
}

/** What the order allows fulfillment to pay (its stored ceiling, never recomputed: docs/06). */
export interface OrderCost {
  readonly costCurrency: CostCurrency;
  readonly costMinor: bigint;
  readonly maxCostMinor: bigint;
}

export interface CoreLimits {
  /** SUPPLIER_MAX_PER_ORDER_MICRO_USDT (rules/45 "Limits"). */
  readonly supplierMaxPerOrderMicroUsdt: bigint;
  /** FRAGMENT_PAY_ADDRESSES, raw (the TON module's TON_PAY_ADDRESSES set). */
  readonly payAddresses: ReadonlySet<string>;
}

export type PreparedVerdict =
  | { readonly kind: 'SEND' }
  | { readonly kind: 'HOLD'; readonly reason: OrderStatusReason; readonly why: string };

function hold(reason: OrderStatusReason, why: string): PreparedVerdict {
  return { kind: 'HOLD', reason, why };
}

/**
 * Whether a prepared payout may get its SENDING row, checked BEFORE anything is written (rules/45
 * steps 3 and 4). The TON limits and the balance are the TON module's: it checks them under its
 * own row locks, inside the signing transaction (S5).
 */
export function judgePrepared(
  order: OrderCost,
  prepared: PreparedFulfillment,
  limits: CoreLimits,
): PreparedVerdict {
  // docs/06 "Marshrut va tannarx chegarasi": no cross-currency comparison in phase 5.
  if (prepared.costCurrency !== order.costCurrency) {
    return hold('NO_ADAPTER', 'the adapter is paid in another currency than the order');
  }
  if (prepared.costMinor <= 0n) return hold('ADAPTER_ERROR', 'the adapter priced it at zero');
  const ceiling = { ...order };
  const actual = { currency: prepared.costCurrency, amountMinor: prepared.costMinor };
  if (exceedsCostCeiling(ceiling, actual)) return hold('PRICE_ABOVE_MAX', 'cost above maxCost');
  if (isTonPaid(prepared.costCurrency)) {
    const ton = tonInstructionOf(prepared.request);
    if (ton === null) return hold('ADAPTER_ERROR', 'no valid TON instruction');
    const problem = tonInstructionProblem(ton, limits.payAddresses);
    if (problem !== null) return hold('ADAPTER_ERROR', problem);
    // The amount that is signed is the amount that was compared with the ceiling.
    if (BigInt(ton.amountNano) !== prepared.costMinor) {
      return hold('ADAPTER_ERROR', 'the TON amount differs from the prepared cost');
    }
    // The TON module writes the signed message hash itself (S5): the attempt starts without one.
    if (prepared.externalRef !== null) return hold('ADAPTER_ERROR', 'a TON attempt with a ref');
    return { kind: 'SEND' };
  }
  if (prepared.costMinor > limits.supplierMaxPerOrderMicroUsdt) {
    return hold('LIMIT_PER_ORDER', 'above SUPPLIER_MAX_PER_ORDER_MICRO_USDT');
  }
  // rules/45 step 5: a supplier attempt is committed WITH its precomputed reference, so a crash
  // after the send can still be looked up.
  if (prepared.externalRef === null || prepared.externalRef.trim() === '') {
    return hold('ADAPTER_ERROR', 'a supplier attempt without a precomputed reference');
  }
  return { kind: 'SEND' };
}

/**
 * The same checks the TON module makes before it signs (audit L-4), made BEFORE the SENDING row
 * exists, so a bad instruction is a core hold and never an attempt: the payee parses as a
 * workchain-0 address in FRAGMENT_PAY_ADDRESSES, the payload is a BOC. pay() keeps its own checks.
 */
function tonInstructionProblem(ton: TonInstruction, payAddresses: ReadonlySet<string>) {
  try {
    const to = parseOrderPayoutAddress(ton.toAddress, 'the payout address');
    if (!payAddresses.has(rawAddress(to))) return 'the payee is not in FRAGMENT_PAY_ADDRESSES';
  } catch (error) {
    if (!(error instanceof TonAddressError)) throw error;
    return 'the payee is not a workchain-0 TON address';
  }
  try {
    Cell.fromBase64(ton.payloadBoc);
  } catch {
    return 'the payload is not a BOC';
  }
  return null;
}

/**
 * Whether a supplier's "not sent" proof lets the core fail the attempt and try again by itself
 * (CR M2, audit L-1). Never an operator-only proof (MANUAL needs an OWNER with the OTP) nor a TON
 * proof (a supplier cannot speak for our chain). No supplier proof kind exists yet (S8; adding one
 * changes the proof schema and needs the owner), so today every supplier NOT_SENT is NEEDS_REVIEW.
 */
export function supplierNotSentProven(proof: NeedsReviewProof): boolean {
  return (
    proofJustifies(proof, 'FAILED') && !proofIsOperatorOnly(proof) && !proof.kind.startsWith('TON_')
  );
}

/** An attempt that may have been sent: followed, never paid again (rules/45 step 2). */
export function isLiveAttempt(status: AttemptStatus): boolean {
  return status === 'SENDING' || status === 'SENT' || status === 'UNKNOWN';
}

/** BullMQ: `attemptsMade` counts the finished attempts, so this run is number attemptsMade + 1. */
export function isFinalAttempt(attemptsMade: number, attempts: number | undefined): boolean {
  return attemptsMade + 1 >= (attempts ?? 1);
}

/** The amount a PURCHASE entry of the order must carry: what the customer paid, negative. */
export function purchaseAmountOf(order: {
  readonly priceTiyin: bigint;
  readonly discountTiyin: bigint;
}): bigint {
  return -(order.priceTiyin - order.discountTiyin);
}

/** A retryable "not now" (busy order, a pre-send error): the job's backoff tries again. */
export class RetryLaterError extends Error {
  constructor(readonly why: string) {
    super(`fulfill-order: retry later (${why})`);
    this.name = 'RetryLaterError';
  }
}
