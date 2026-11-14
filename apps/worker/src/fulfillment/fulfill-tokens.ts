import type { FulfillmentAdapter } from '../adapters/fulfillment-adapter';
import type { WorkerConfig } from '../config/config.module';
import type { TonPayRequest, TonPayResult } from '../ton/ton-payout';

// Injection tokens of the fulfillment core (phase 5 S4). Which adapters exist is decided by one
// factory (fulfillment.module.ts, plan §8); the TON payout comes from the TON module (S5) behind
// the narrow TonPayer interface, so the core never sees the wallet or the gateway.

/** `ProductRoute.adapter` code -> adapter. Empty when nothing may run (production dry run). */
export const FULFILL_ADAPTERS = Symbol('FULFILL_ADAPTERS');
export const FULFILL_TIMING = Symbol('FULFILL_TIMING');
export const FULFILL_HOOKS = Symbol('FULFILL_HOOKS');
/** The TON payout of an attempt: TonSenderService.pay (S5). */
export const TON_PAYER = Symbol('TON_PAYER');
/** The cooperative `lock:order:{id}` store (Redis; a granting store in the DB-fence tests). */
export const ORDER_LOCK_STORE = Symbol('ORDER_LOCK_STORE');

export type AdapterRegistry = ReadonlyMap<string, FulfillmentAdapter>;

export interface TonPayer {
  /** A throw means "outcome unknown" (ton-payout.ts): never a reason to fail, hold or refund. */
  pay(request: TonPayRequest): Promise<TonPayResult>;
}

export interface FulfillTiming {
  /** Pause between two supplier status looks. */
  readonly pollMs: number;
  /**
   * TON_CONFIRM_TIMEOUT_MS: how long a sent supplier payout is watched before NEEDS_REVIEW (the
   * TON wait itself is the TON module's, on the same setting).
   */
  readonly confirmTimeoutMs: number;
  /** TTL of `lock:order:{id}`; renewed while the run lasts, so a dead worker frees it soon. */
  readonly orderLockTtlMs: number;
}

export const DEFAULT_SUPPLIER_POLL_MS = 3_000;
/**
 * Shorter than the shortest wait of a stalled job (FULFILL_ORDER_LOCK_DURATION_MS / 2 = 120 s) and
 * than the job's first retries' total (5 + 10 + 20 + 40 s), so a dead worker's lease is gone by
 * the time its job runs again.
 */
export const DEFAULT_ORDER_LOCK_TTL_MS = 60_000;

export function fulfillTimingOf(config: WorkerConfig): FulfillTiming {
  return {
    pollMs: DEFAULT_SUPPLIER_POLL_MS,
    confirmTimeoutMs: config.TON_CONFIRM_TIMEOUT_MS,
    orderLockTtlMs: DEFAULT_ORDER_LOCK_TTL_MS,
  };
}

/**
 * Death points of the core for the crash tests (a hook that throws stands for a process that died
 * right there). Production uses the no-op hooks.
 */
export interface FulfillHooks {
  /** After FulfillmentAttempt SENDING committed, before anything is signed or sent. */
  afterSendingCommitted(attemptId: string): Promise<void>;
}

export const NO_FULFILL_HOOKS: FulfillHooks = Object.freeze({
  afterSendingCommitted: () => Promise.resolve(),
});
