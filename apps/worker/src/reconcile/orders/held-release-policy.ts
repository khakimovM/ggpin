import {
  HELD_AUTO_RELEASE_MAX,
  RELEASABLE_HELD_REASONS,
  checkTonLimits,
  coversPayout,
  type CostCurrency,
  type ReleasableHeldReason,
  type TonLimits,
} from '@repo/shared';
import { RECHECK_MAX_AGE_MS } from '../../fulfillment/fulfill-recipient';
import type { HeldPayout } from './held-payout';

// What the order reconciler does with one HELD order (phase 5 S9e, D-64 (4), Q-2, Q-3, Q-8). Pure:
// every input was read from the database or the worker's config by the caller (no provider is
// asked anything here), every clock is the DATABASE clock of the tick. Two stages:
//
// 1. `triageHeld` (no source reads): a PURCHASE debit that does not match the order is a money
//    anomaly (NO_PURCHASE: never refunded, never released, only the owner); a payout row that is
//    not provably unsent (a late chain fact, a transfer that is not EXPIRED: S9f M-1 / L-1) keeps
//    the order for the owner whatever its age or reason (PAYOUT); a hold that reached
//    HELD_MAX_AGE_MS since its LATEST HELD event (`>=`) is refunded, whatever its reason; an
//    ADAPTER_ERROR hold (the attempt cap, a refused SENDING, a stale re-check, a refused prepare,
//    NO_PURCHASE...) and any reason we do not know is never released; an order the reconciler has
//    already released HELD_AUTO_RELEASE_MAX times stays for the owner or the refund.
// 2. `releaseVerdict`: the five releasable reasons are released only when NOTHING the run checks
//    first would hold the order again. Missing evidence keeps only the reason that needs it (no
//    fresh cost keeps PRICE_ABOVE_MAX, no fresh balance keeps LOW_BALANCE); evidence of a problem
//    keeps every reason (a release that the run holds again only burns one of the three).
//
// The fulfill run re-checks everything under the order lock before any payout: a release is never
// a payment decision, only "worth another run".

/** The HELD reasons the reconciler may release by itself (D-64 (4)): the shared list. */
export type ReleasableReason = ReleasableHeldReason;

/**
 * The note of the reconciler's HELD -> QUEUED event: `reconcile release: <REASON>`. The release
 * cap counts these events (no migration: OrderEvent is the record).
 */
export const RECONCILE_RELEASE_NOTE_PREFIX = 'reconcile release: ';

/**
 * The note of the reconciler's HELD -> FAILED event (technical English, like every system-written
 * note): the resend of a refund's effects looks for exactly this event (S9e fix CR F5).
 */
export const HELD_EXPIRED_NOTE = 'reconcile: held for HELD_MAX_AGE_MS, refunded';

/**
 * Q-8: a handle issued by another adapter is re-checked only while the order is younger than
 * RECHECK_MAX_AGE_MS (else the run holds it again, STALE). Released only while it is younger than
 * that minus this margin, so the run that the release starts still finds it fresh.
 */
export const RECHECK_SAFETY_MS = 5 * 60_000;

export interface HeldFacts {
  /** `Order.statusReason` as stored (null or an unknown text is never released). */
  readonly reason: string | null;
  /** `createdAt` of the order's latest HELD event (database clock, epoch ms). */
  readonly heldAtMs: number;
  /** The order's PURCHASE entry exists, is the owner's, and took `priceTiyin - discountTiyin`. */
  readonly purchaseMatches: boolean;
  /** HELD -> QUEUED events the reconciler wrote for this order. */
  readonly releasesUsed: number;
  /** What the order's attempts and transfers say (held-payout.ts); only `clean` may move. */
  readonly payout: HeldPayout;
}

export type KeepWhy =
  | 'adapterError'
  | 'notReleasable'
  | 'releaseCap'
  | 'badClock'
  | 'noRoute'
  | 'recheckStale'
  | 'noCost'
  | 'price'
  | 'limit'
  | 'noBalance'
  | 'balance'
  | 'badAmount';

export type HeldTriage =
  | { readonly kind: 'NO_PURCHASE' }
  | { readonly kind: 'PAYOUT'; readonly why: Exclude<HeldPayout, 'clean'> }
  | { readonly kind: 'REFUND' }
  | { readonly kind: 'KEEP'; readonly why: KeepWhy }
  | { readonly kind: 'CHECK'; readonly reason: ReleasableReason };

function releasable(reason: string | null): ReleasableReason | null {
  return RELEASABLE_HELD_REASONS.find((known) => known === reason) ?? null;
}

/** Stage 1: refund, a money anomaly, keep, or look at the sources of a releasable reason. */
export function triageHeld(facts: HeldFacts, nowMs: number, heldMaxAgeMs: number): HeldTriage {
  if (!facts.purchaseMatches) return { kind: 'NO_PURCHASE' };
  // S9f M-1 / L-1: neither a release nor a refund beside a payout that may have gone out.
  if (facts.payout !== 'clean') return { kind: 'PAYOUT', why: facts.payout };
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(facts.heldAtMs)) {
    return { kind: 'KEEP', why: 'badClock' };
  }
  // Q-2: from the LATEST hold, inclusive: exactly HELD_MAX_AGE_MS is already too long.
  if (nowMs - facts.heldAtMs >= heldMaxAgeMs) return { kind: 'REFUND' };
  const reason = releasable(facts.reason);
  if (reason === null) {
    return {
      kind: 'KEEP',
      why: facts.reason === 'ADAPTER_ERROR' ? 'adapterError' : 'notReleasable',
    };
  }
  if (!Number.isSafeInteger(facts.releasesUsed) || facts.releasesUsed >= HELD_AUTO_RELEASE_MAX) {
    return { kind: 'KEEP', why: 'releaseCap' };
  }
  return { kind: 'CHECK', reason };
}

/** What the run that a release starts would pick, and how old the customer's confirmation is. */
export interface RouteEvidence {
  /** `AdapterRouter.pick(product, previous attempt's adapter, issuer, cost currency)`; null: none. */
  readonly picked: string | null;
  /** The adapter that issued the stored recipient handle (null: a plain handle, never re-checked). */
  readonly issuer: string | null;
  /** Database clock now minus `Order.createdAt`. */
  readonly orderAgeMs: number;
}

/** The hot wallet's numbers (TON orders only). */
export interface TonEvidence {
  readonly limits: TonLimits;
  /** The rolling 24 h sum of the wallet's transfers (every status, like the signing check). */
  readonly spentLast24hNano: bigint;
  /** The newest FRESH WalletSnapshot; null when there is none (a dry run records none). */
  readonly balanceNano: bigint | null;
  readonly feeReserveNano: bigint;
}

export interface ReleaseEvidence {
  readonly route: RouteEvidence;
  readonly currency: CostCurrency;
  readonly maxCostMinor: bigint;
  /** The order's quantity at the picked adapter's newest FRESH cost snapshot; null: none. */
  readonly freshCostMinor: bigint | null;
  /** The larger of the order's cost and its latest attempt's cost (what was refused). */
  readonly knownCostMinor: bigint;
  /** Present for a TON order. */
  readonly ton: TonEvidence | null;
  readonly supplierMaxPerOrderMicroUsdt: bigint;
}

export type ReleaseVerdict =
  { readonly release: true } | { readonly release: false; readonly why: KeepWhy };

const keep = (why: KeepWhy): ReleaseVerdict => ({ release: false, why });

function routeProblem(route: RouteEvidence): KeepWhy | null {
  if (route.picked === null) return 'noRoute';
  if (route.issuer === null || route.picked === route.issuer) return null;
  return route.orderAgeMs < RECHECK_MAX_AGE_MS - RECHECK_SAFETY_MS ? null : 'recheckStale';
}

function tonProblem(reason: ReleasableReason, amount: bigint, ton: TonEvidence): KeepWhy | null {
  if (!checkTonLimits(amount, ton.spentLast24hNano, ton.limits).ok) return 'limit';
  if (ton.balanceNano === null) return reason === 'LOW_BALANCE' ? 'noBalance' : null;
  return coversPayout(ton.balanceNano, amount, ton.feeReserveNano) ? null : 'balance';
}

function supplierProblem(reason: ReleasableReason, amount: bigint, max: bigint): KeepWhy | null {
  // The daily limit and the balance are the TON module's: a USDT order never holds on them.
  if (reason === 'LIMIT_DAILY' || reason === 'LOW_BALANCE') return 'notReleasable';
  return amount > max ? 'limit' : null;
}

/** Stage 2: RELEASE only when the run would not hold the order again for any reason it checks. */
export function releaseVerdict(
  reason: ReleasableReason,
  evidence: ReleaseEvidence,
): ReleaseVerdict {
  const route = routeProblem(evidence.route);
  if (route !== null) return keep(route);
  const fresh = evidence.freshCostMinor;
  if (fresh === null && reason === 'PRICE_ABOVE_MAX') return keep('noCost');
  if (fresh !== null && fresh > evidence.maxCostMinor) return keep('price');
  // What the next payout would cost at most: never less than what was already refused.
  const amount =
    fresh !== null && fresh > evidence.knownCostMinor ? fresh : evidence.knownCostMinor;
  if (amount < 1n) return keep('badAmount');
  const problem =
    evidence.currency === 'TON'
      ? evidence.ton === null
        ? 'noBalance'
        : tonProblem(reason, amount, evidence.ton)
      : supplierProblem(reason, amount, evidence.supplierMaxPerOrderMicroUsdt);
  return problem === null ? { release: true } : keep(problem);
}
