import { Inject, Injectable, Logger } from '@nestjs/common';
import { coversPayout } from '@repo/shared';
import type { Address } from '@ton/core';
import { WORKER_CONFIG, type WorkerConfig } from '../config/config.module';
import { parseTonAddress, rawAddress } from './ton-address';
import { TonConfirmService } from './ton-confirm.service';
import { errorKind } from './ton-db-errors';
import { TonGatewayError, type TonAccountState, type TonGateway } from './ton-gateway';
import type { TonLease, TonWalletLock } from './ton-lock';
import { blocksWallet, heldNotices, walletBlockedNotice } from './ton-notices';
import { TonNotifier } from './ton-notifier';
import {
  payResultOf,
  type TonPayRequest,
  type TonPayResult,
  type TonStopReason,
} from './ton-payout';
import {
  MAX_DB_CLOCK_SKEW_MS,
  TON_GATEWAY,
  TON_PAY_ADDRESSES,
  TON_SENDER_HOOKS,
  TON_TIMING,
  TON_WALLET,
  TON_WALLET_LOCK,
  signLagMaxSec,
  type TonPayAddresses,
  type TonSenderHooks,
  type TonTiming,
} from './ton-tokens';
import {
  TonTransferRepository,
  type NotStored,
  type StoredTransfer,
} from './ton-transfer.repository';
import { w5ViewOf } from './ton-w5';
import type { TonWallet } from './ton-wallet';

// One TON payout of a fulfillment attempt (plan 6.4, docs/06 "5-faza S1"), in this order:
//  1. the attempt already has a transfer -> only follow it, lock or no lock (review m1): never
//     sign or broadcast again;
//  2. the payee is not in FRAGMENT_PAY_ADDRESSES (workchain 0) -> HELD before signing (audit L1);
//  3. the wallet lock (Redis, cooperative; fail-closed before signing), then step 1 once more;
//  4. the wallet has another unresolved transfer -> look at it first; still open -> WALLET_BUSY
//     (and tonWalletBlocked once it outlived TON_CONFIRM_TIMEOUT_MS, review M4);
//  5. the order is still PROCESSING and the attempt SENDING (a stalled worker stops here; the
//     replay of a job that held the order sends the hold's notices again);
//  6. one chain snapshot: our W5R1 wallet, its seqno, balance (+ fee reserve) and the chain time,
//     which must agree with our clock, and our clock with the database's (review m5);
//  7. ONE transaction: re-check under the row locks (payee, database clock vs chain time, limits
//     over the rolling 24 h), sign, externalRef CAS, TonTransfer SIGNED with the BOC -> commit;
//     only THEN
//  8. one broadcast (a failure is not "not sent": nothing is ever re-sent), BROADCAST / SENT;
//  9. the confirmation wait (TonConfirmService) -> DELIVERED / EXPIRED / REVIEW.

const MS_PER_SEC = 1_000;

@Injectable()
export class TonSenderService {
  private readonly logger = new Logger(TonSenderService.name);
  /**
   * The signer, in a #private field (audit I-1): a module that gets this service from the Nest
   * container (the fulfillment core) cannot read the signer off it, not even through a cast.
   */
  readonly #wallet: TonWallet;

  constructor(
    private readonly transfers: TonTransferRepository,
    private readonly confirm: TonConfirmService,
    private readonly notifier: TonNotifier,
    @Inject(TON_GATEWAY) private readonly gateway: TonGateway,
    @Inject(TON_WALLET) wallet: TonWallet,
    @Inject(TON_WALLET_LOCK) private readonly lock: TonWalletLock,
    @Inject(TON_TIMING) private readonly timing: TonTiming,
    @Inject(TON_SENDER_HOOKS) private readonly hooks: TonSenderHooks,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(TON_PAY_ADDRESSES) private readonly payAddresses: TonPayAddresses,
  ) {
    this.#wallet = wallet;
  }

  /**
   * A throw means "outcome unknown" (ton-payout.ts, review m2): a retry of the same attempt is
   * always safe, and a throw is never a reason to fail, hold or refund the order.
   */
  async pay(request: TonPayRequest): Promise<TonPayResult> {
    const to = parseTonAddress(request.toAddress, 'the payout address');
    if (request.amountNano <= 0n) throw new RangeError('a TON payout must be a positive amount');
    const own = await this.transfers.findByAttempt(request.attemptId);
    if (own !== null) return this.follow(own.id);
    if (to.workChain !== 0 || !this.payAddresses.has(rawAddress(to))) {
      this.logger.error(`order ${request.orderId}: payout address not in FRAGMENT_PAY_ADDRESSES`);
      const held = await this.transfers.holdBeforeSigning(
        request.orderId,
        request.attemptId,
        'PAY_ADDRESS_NOT_ALLOWED',
      );
      return this.afterHold(request, held);
    }
    const lease = await this.lock.acquire();
    if (lease === null) return { status: 'NOT_SENT', reason: 'WALLET_BUSY' };
    try {
      return await this.payLocked(request, to, lease);
    } finally {
      await lease.release();
    }
  }

  /** The attempt's own transfer: watched to its outcome, never signed or broadcast again. */
  private async follow(transferId: string, lease?: TonLease): Promise<TonPayResult> {
    const keepAlive = lease === undefined ? undefined : () => lease.renew();
    return payResultOf(transferId, await this.confirm.awaitOutcome(transferId, keepAlive));
  }

  private async payLocked(
    request: TonPayRequest,
    to: Address,
    lease: TonLease,
  ): Promise<TonPayResult> {
    // Another call of this attempt may have signed between the look in pay() and the lock.
    const own = await this.transfers.findByAttempt(request.attemptId);
    if (own !== null) return this.follow(own.id, lease);
    const network = this.config.TON_NETWORK;
    const blocking = await this.transfers.findUnresolved(network, this.#wallet.rawAddress);
    if (blocking !== null && (await this.stillBlocking(blocking))) {
      return { status: 'NOT_SENT', reason: 'WALLET_BUSY' };
    }
    const stop = await this.transfers.preflight(request.orderId, request.attemptId);
    if (stop !== null) return this.stopped(request.orderId, stop);
    const snapshot = await this.snapshot();
    if ('status' in snapshot) return snapshot;
    const { state, seqno, deploy } = snapshot;
    if (!coversPayout(state.balanceNano, request.amountNano, this.config.TON_FEE_RESERVE_NANO)) {
      const held = await this.transfers.holdBeforeSigning(
        request.orderId,
        request.attemptId,
        'LOW_BALANCE',
      );
      return this.afterHold(request, held);
    }
    const validUntilSec = state.chainTime + this.config.TON_SEND_VALID_SEC;
    const stored = await this.transfers.signAndStore({
      order: {
        orderId: request.orderId,
        attemptId: request.attemptId,
        allowedTo: this.payAddresses,
      },
      network,
      walletAddress: this.#wallet.rawAddress,
      toAddress: rawAddress(to),
      amountNano: request.amountNano,
      seqno,
      validUntilSec,
      limits: {
        perOrderMaxNano: this.config.TON_MAX_PER_ORDER_NANO,
        dailyMaxNano: this.config.TON_MAX_DAILY_NANO,
      },
      chainTimeSec: state.chainTime,
      maxSignLagSec: signLagMaxSec(this.timing),
      // Bounceable: if Fragment's contract refuses the payment, the value comes back (A1).
      sign: () =>
        this.#wallet.sign({
          seqno,
          validUntilSec,
          to,
          amountNano: request.amountNano,
          body: request.payload,
          bounce: true,
          deploy,
        }),
    });
    if (stored.kind !== 'STORED') return this.afterHold(request, stored);
    const transferId = stored.transfer.id;
    await this.hooks.afterStored(transferId);
    await this.broadcast(transferId, stored.signed.boc, request.attemptId);
    await this.hooks.afterBroadcast(transferId);
    const state2 = await this.confirm.awaitOutcome(transferId, () => lease.renew());
    return payResultOf(transferId, state2);
  }

  /** The one snapshot the signing decision rests on, or why nothing can be signed now. */
  private async snapshot(): Promise<
    | { readonly state: TonAccountState; readonly seqno: number; readonly deploy: boolean }
    | Extract<TonPayResult, { readonly status: 'NOT_SENT' }>
  > {
    let state: TonAccountState;
    try {
      state = await this.gateway.getAccountState(this.#wallet.address);
    } catch (error) {
      if (!(error instanceof TonGatewayError)) throw error;
      this.logger.warn(`ton payout not signed: ${error.message}`);
      return { status: 'NOT_SENT', reason: 'GATEWAY' };
    }
    const view = w5ViewOf(state, this.#wallet.own);
    if (!view.ready) {
      this.logger.error(`ton payout not signed: the hot wallet is not usable (${view.why})`);
      return { status: 'NOT_SENT', reason: 'WALLET_NOT_READY' };
    }
    const skew = Math.abs(state.chainTime - Math.floor(Date.now() / MS_PER_SEC));
    if (skew > this.timing.maxClockSkewSec) {
      this.logger.error(`ton payout not signed: chain time is ${String(skew)} s off our clock`);
      return { status: 'NOT_SENT', reason: 'CLOCK_SKEW' };
    }
    const dbSkewMs = Math.abs((await this.transfers.databaseNowMs()) - Date.now());
    if (dbSkewMs > MAX_DB_CLOCK_SKEW_MS) {
      this.logger.error(`ton payout not signed: the database clock is ${String(dbSkewMs)} ms off`);
      return { status: 'NOT_SENT', reason: 'CLOCK_SKEW' };
    }
    return { state, seqno: view.seqno, deploy: view.deploy };
  }

  /**
   * One look at the wallet's unresolved transfer. Still unresolved -> the wallet is busy, and once
   * the transfer outlived TON_CONFIRM_TIMEOUT_MS (database clock) no sender settles it any more:
   * the owner hears tonWalletBlocked (stable id per transfer, so a repeat is dropped).
   */
  private async stillBlocking(blocking: StoredTransfer): Promise<boolean> {
    const { state } = await this.confirm.check(blocking.id);
    if (state.transferStatus !== 'SIGNED' && state.transferStatus !== 'BROADCAST') return false;
    const now = await this.transfers.databaseNowMs();
    if (blocksWallet(blocking.createdAt, now, this.timing.confirmTimeoutMs)) {
      this.logger.error(`the TON hot wallet is blocked by transfer ${blocking.id}`);
      await this.notifier.send([walletBlockedNotice(blocking.id)]);
    }
    return true;
  }

  /**
   * Exactly one sendBoc; a failure is logged, never retried (the chain decides, plan 6.5). The
   * BROADCAST / SENT marks are bookkeeping only: if they cannot be written the rows stay SIGNED /
   * SENDING, from which every chain outcome is still allowed, so nothing here throws.
   */
  private async broadcast(transferId: string, boc: Buffer, attemptId: string): Promise<void> {
    try {
      await this.gateway.sendBoc(boc);
    } catch (error) {
      this.logger.warn(`ton transfer ${transferId}: broadcast unclear (${errorKind(error)})`);
      return;
    }
    try {
      await this.transfers.markBroadcast(transferId, attemptId);
    } catch (error) {
      this.logger.error(`ton transfer ${transferId}: BROADCAST not recorded (${errorKind(error)})`);
    }
  }

  /**
   * Nothing to do for this job. When the order is HELD for a TON reason, this is the replay of the
   * job that held it (its notices may never have reached the queue): they are sent again. Their
   * job ids are stable, so nobody hears twice (rules/45: a hold is never silent).
   */
  private async stopped(orderId: string, reason: TonStopReason): Promise<TonPayResult> {
    if (reason === 'ORDER_NOT_PROCESSING') {
      const held = await this.transfers.tonHoldOf(orderId);
      if (held !== null) {
        await this.notifier.send(heldNotices(orderId, held.attemptId, held.reason));
      }
    }
    return { status: 'STOPPED', reason };
  }

  private async afterHold(request: TonPayRequest, result: NotStored): Promise<TonPayResult> {
    const { orderId, attemptId } = request;
    switch (result.kind) {
      case 'HELD':
        this.logger.warn(`order ${orderId} held before signing: ${result.reason}`);
        await this.notifier.send(heldNotices(orderId, attemptId, result.reason));
        return { status: 'HELD', reason: result.reason };
      case 'STOPPED':
        this.logger.warn(`order ${orderId}: nothing signed (${result.reason})`);
        // The replay of a job that held the order: its notices are sent again (stable ids).
        return this.stopped(orderId, result.reason);
      case 'BUSY':
        return { status: 'NOT_SENT', reason: 'WALLET_BUSY' };
      case 'SKEWED':
        this.logger.error(`order ${orderId}: nothing signed, database clock ahead of the chain`);
        return { status: 'NOT_SENT', reason: 'CLOCK_SKEW' };
    }
  }
}
