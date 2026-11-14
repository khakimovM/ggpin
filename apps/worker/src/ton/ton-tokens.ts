import type { Address } from '@ton/core';
import type { TonNetwork } from './ton-mnemonic';

// Injection tokens of the TON module. The gateway and the wallet are interfaces/instances built by
// factories (ton-factories.ts): which one exists depends on FULFILLMENT_DRY_RUN, so no consumer
// ever constructs a real chain client or opens the mnemonic itself. TON_WALLET (the signer) stays
// inside the module; other modules get TON_HOT_WALLET_ADDRESS only (audit L1).

export const TON_GATEWAY = Symbol('TON_GATEWAY');
export const TON_WALLET = Symbol('TON_WALLET');
export const TON_HOT_WALLET_ADDRESS = Symbol('TON_HOT_WALLET_ADDRESS');
export const TON_TIMING = Symbol('TON_TIMING');
export const TON_WALLET_LOCK = Symbol('TON_WALLET_LOCK');
export const TON_SENDER_HOOKS = Symbol('TON_SENDER_HOOKS');
/** The raw addresses an ORDER payout may go to (FRAGMENT_PAY_ADDRESSES, D-56 (5)). */
export const TON_PAY_ADDRESSES = Symbol('TON_PAY_ADDRESSES');
/**
 * Second, independent chain sources (TonChainWitness: reads only) that must agree before a transfer
 * counts as EXPIRED (D-60 (2), review m3): empty until one is chosen; mandatory before mainnet (the
 * env refuses a live mainnet boot). One that contradicts the primary source is WITNESS_CONFLICT.
 */
export const TON_EXPIRY_WITNESSES = Symbol('TON_EXPIRY_WITNESSES');

/** What other modules may know about the hot wallet: where it is, never how to sign. */
export interface TonHotWalletAddress {
  readonly network: TonNetwork;
  readonly address: Address;
  readonly rawAddress: string;
}

/** The cooperative Redis lock of the hot wallet (docs/06, plan 6.4); the DB index is the fence. */
export const TON_WALLET_LOCK_KEY = 'lock:ton-wallet';

export interface TonTiming {
  /** Pause between two looks at the chain while a payout is unresolved. */
  readonly pollMs: number;
  /**
   * Chain seconds after OUR transaction during which a destination transaction that is not visible
   * yet is waited for; past it the payout counts as delivered (D-56 (5), Q6). A later bounce is the
   * reconciler's (CONFIRMED -> BOUNCED). S9 fixture bilan aniqlanadi: the real index delay.
   */
  readonly destGraceSec: number;
  /** TON_CONFIRM_TIMEOUT_MS: from the transfer's creation to NEEDS_REVIEW (docs/06: 5 minutes). */
  readonly confirmTimeoutMs: number;
  /** TTL of the wallet lock; renewed on every poll, so a dead worker frees it within this time. */
  readonly lockTtlMs: number;
  /** Seconds the snapshot's chain time may differ from our clock before nothing is signed. */
  readonly maxClockSkewSec: number;
  /** D-60 (2): the least time between the two observations that make a transfer EXPIRED. */
  readonly expiryGapSec: number;
}

export const DEFAULT_POLL_MS = 3_000;
export const DEFAULT_DEST_GRACE_SEC = 20;
export const DEFAULT_LOCK_TTL_MS = 120_000;
// Review m5: chain time, our clock and the database clock must agree closely before anything is
// signed, so the scan window (createdAt - scanSlackSec) always holds our transaction.
export const DEFAULT_MAX_CLOCK_SKEW_SEC = 60;
/** How far our clock may be from the database clock before nothing is signed. */
export const MAX_DB_CLOCK_SKEW_MS = 30_000;
/** Room for block times around the snapshot's chain time (a shard block vs the masterchain). */
const SCAN_SLACK_RESERVE_SEC = 30;

/**
 * How far the database clock may be ahead of the chain time a message is signed at. The signing
 * transaction refuses beyond it, and the transfer's `createdAt` IS that transaction's `now()`, so
 * our transaction's chain time is never older than `createdAt` minus this (review m5).
 */
export function signLagMaxSec(timing: Pick<TonTiming, 'maxClockSkewSec'>): number {
  return timing.maxClockSkewSec + MAX_DB_CLOCK_SKEW_MS / 1_000;
}

/** The scan window starts this long before the transfer's `createdAt` (database clock). */
export function scanSlackSec(timing: Pick<TonTiming, 'maxClockSkewSec'>): number {
  return signLagMaxSec(timing) + SCAN_SLACK_RESERVE_SEC;
}

/** The raw addresses (workchain 0) an ORDER payout may go to: FRAGMENT_PAY_ADDRESSES. */
export type TonPayAddresses = ReadonlySet<string>;

/**
 * Death points of the sending path for the crash tests (a hook that throws stands for a process
 * that died right there). Production uses the no-op hooks.
 */
export interface TonSenderHooks {
  /** After the SIGNED transfer committed, before anything was broadcast. */
  afterStored(transferId: string): Promise<void>;
  /** After the one broadcast call returned (or failed), before the confirmation wait. */
  afterBroadcast(transferId: string): Promise<void>;
}

export const NO_SENDER_HOOKS: TonSenderHooks = Object.freeze({
  afterStored: () => Promise.resolve(),
  afterBroadcast: () => Promise.resolve(),
});
