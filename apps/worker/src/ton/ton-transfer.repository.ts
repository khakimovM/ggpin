import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, TonTransferStatus, Tx } from '@repo/db';
import { checkTonLimits, type TonLimits } from '@repo/shared';
import { isUniqueViolation } from '../bank-feed/prisma-errors';
import { PrismaService } from '../infra/prisma/prisma.service';
import { isGuardRefusal } from './ton-db-errors';
import type { TonNetwork } from './ton-mnemonic';
import type { TonHoldReason, TonStopReason } from './ton-payout';
import {
  databaseLagSec,
  gate,
  hold,
  holdReasonOf,
  spentLast24h,
  type HoldError,
} from './ton-sign-guards';
import type { TonPayAddresses } from './ton-tokens';
import type { SignedTransfer } from './ton-wallet';

// All Prisma access of the sending side (rules/10: repositories hold the queries). The signing
// transaction follows docs/06 "Yuborishdan oldin worker nimani qayta tekshiradi": under the order
// and attempt row locks it re-checks order PROCESSING and attempt SENDING with no reference yet,
// checks the payee against FRAGMENT_PAY_ADDRESSES and its own clock against the chain time, sums
// the rolling 24 h spend, signs, writes `externalRef` with a compare-and-set and inserts the
// SIGNED transfer, all in ONE commit that happens BEFORE anything is broadcast. The partial unique
// indexes of migration 10 (one unresolved message per wallet, one live message per seqno) are the
// fence that holds even when the Redis lock is lost: a second writer gets BUSY.

export type PrismaHolder = Pick<PrismaService, 'client'>;

export interface StoredTransfer {
  readonly id: string;
  readonly purpose: string;
  readonly attemptId: string | null;
  readonly network: string;
  readonly walletAddress: string;
  readonly seqno: number;
  readonly validUntil: Date;
  readonly toAddress: string;
  readonly amountNanoTon: bigint;
  readonly payloadHash: string;
  readonly extMsgHash: string;
  readonly status: TonTransferStatus;
  readonly txHash: string | null;
  readonly createdAt: Date;
}

// The signed BOC is never read back: a message is never broadcast twice (plan 6.5).
const TRANSFER_SELECT = {
  id: true,
  purpose: true,
  attemptId: true,
  network: true,
  walletAddress: true,
  seqno: true,
  validUntil: true,
  toAddress: true,
  amountNanoTon: true,
  payloadHash: true,
  extMsgHash: true,
  status: true,
  txHash: true,
  createdAt: true,
} satisfies Prisma.TonTransferSelect;

export interface StoreOrder {
  readonly orderId: string;
  readonly attemptId: string;
  /** FRAGMENT_PAY_ADDRESSES: an ORDER payout to any other address is held, never signed (L1). */
  readonly allowedTo: TonPayAddresses;
}

export interface StoreRequest {
  /** null for the testnet self-test (purpose SELFTEST, no order). */
  readonly order: StoreOrder | null;
  readonly network: TonNetwork;
  readonly walletAddress: string;
  readonly toAddress: string;
  readonly amountNano: bigint;
  readonly seqno: number;
  readonly validUntilSec: number;
  readonly limits: TonLimits;
  /** The chain time of the snapshot the message is signed at (unix s). */
  readonly chainTimeSec: number;
  /** signLagMaxSec: how far the database clock may be ahead of that chain time (review m5). */
  readonly maxSignLagSec: number;
  /** Signs in memory; called only after every check passed, inside the transaction. */
  readonly sign: () => SignedTransfer;
}

export type StoreResult =
  | { readonly kind: 'STORED'; readonly transfer: StoredTransfer; readonly signed: SignedTransfer }
  | { readonly kind: 'STOPPED'; readonly reason: TonStopReason }
  | { readonly kind: 'HELD'; readonly reason: TonHoldReason }
  | { readonly kind: 'BUSY' }
  /** The database clock is too far ahead of the chain time: nothing signed, retry later. */
  | { readonly kind: 'SKEWED' };

/** Every result in which nothing was signed. */
export type NotStored = Exclude<StoreResult, { readonly kind: 'STORED' }>;

/** A TON hold of an order: its reason and the attempt that was failed by it. */
export interface TonHold {
  readonly reason: TonHoldReason;
  readonly attemptId: string;
}

const HOLD_ERRORS: readonly HoldError[] = [
  'LIMIT_PER_ORDER',
  'LIMIT_DAILY',
  'LOW_BALANCE',
  'PAY_ADDRESS_NOT_ALLOWED',
];

@Injectable()
export class TonTransferRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaHolder) {}

  findById(id: string): Promise<StoredTransfer | null> {
    return this.prisma.client.tonTransfer.findUnique({ where: { id }, select: TRANSFER_SELECT });
  }

  findByAttempt(attemptId: string): Promise<StoredTransfer | null> {
    return this.prisma.client.tonTransfer.findUnique({
      where: { attemptId },
      select: TRANSFER_SELECT,
    });
  }

  /** The wallet's one unresolved message (SIGNED or BROADCAST), if any. */
  findUnresolved(network: TonNetwork, walletAddress: string): Promise<StoredTransfer | null> {
    return this.prisma.client.tonTransfer.findFirst({
      where: { network, walletAddress, status: { in: ['SIGNED', 'BROADCAST'] } },
      select: TRANSFER_SELECT,
    });
  }

  /** The database clock in epoch ms (read as epoch, never as timestamptz: docs/06 L1). */
  async databaseNowMs(): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ ms: string }[]>`
      SELECT floor(extract(epoch from now()) * 1000)::bigint::text AS "ms"`;
    const ms = Number(rows[0]?.ms);
    if (!Number.isSafeInteger(ms)) throw new Error('the database clock could not be read');
    return ms;
  }

  /** A cheap look before the chain is asked anything; `signAndStore` checks again under lock. */
  async preflight(orderId: string, attemptId: string): Promise<TonStopReason | null> {
    const result = await this.prisma.client.$transaction((tx) => gate(tx, orderId, attemptId));
    return result.ok ? null : result.reason;
  }

  /**
   * The TON hold of a HELD order and the attempt it failed, or null: a replay re-sends that
   * hold's notices under the same ids, a later hold (another attempt) gets new ones (review m7).
   * The order's LATEST attempt must be that hold (S4 CR m4): an older TON hold followed by a hold
   * of another kind (the core's TON_NOT_SENT_*) is not this order's hold any more.
   */
  async tonHoldOf(orderId: string): Promise<TonHold | null> {
    const order = await this.prisma.client.order.findUnique({
      where: { id: orderId },
      select: { status: true, statusReason: true },
    });
    if (order?.status !== 'HELD') return null;
    const attempt = await this.prisma.client.fulfillmentAttempt.findFirst({
      where: { orderId },
      orderBy: { attemptNo: 'desc' },
      select: { id: true, status: true, error: true },
    });
    const error = HOLD_ERRORS.find((known) => known === attempt?.error);
    if (attempt?.status !== 'FAILED' || error === undefined) return null;
    const reason = holdReasonOf(error);
    return order.statusReason === reason ? { reason, attemptId: attempt.id } : null;
  }

  /** The wallet cannot pay: the order is held before anything is signed. */
  async holdBeforeSigning(
    orderId: string,
    attemptId: string,
    error: HoldError,
  ): Promise<NotStored> {
    return this.prisma.client.$transaction(async (tx): Promise<NotStored> => {
      const checked = await gate(tx, orderId, attemptId);
      if (!checked.ok) return { kind: 'STOPPED', reason: checked.reason };
      await hold(tx, orderId, attemptId, error);
      return { kind: 'HELD', reason: holdReasonOf(error) };
    });
  }

  async signAndStore(request: StoreRequest): Promise<StoreResult> {
    try {
      return await this.prisma.client.$transaction((tx) => this.storeIn(tx, request));
    } catch (error) {
      // Another message of the wallet is unresolved, or the seqno is taken: the DB fence held.
      if (isUniqueViolation(error)) return { kind: 'BUSY' };
      // The order or the attempt moved between our checks and the insert (the guard re-checks).
      if (isGuardRefusal(error)) return { kind: 'STOPPED', reason: 'GUARD_REFUSED' };
      throw error;
    }
  }

  /** Handed to the network: transfer SIGNED -> BROADCAST, attempt SENDING -> SENT. */
  async markBroadcast(transferId: string, attemptId: string | null): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      if (attemptId !== null) {
        await tx.fulfillmentAttempt.updateMany({
          where: { id: attemptId, status: 'SENDING' },
          data: { status: 'SENT' },
        });
      }
      await tx.tonTransfer.updateMany({
        where: { id: transferId, status: 'SIGNED' },
        data: { status: 'BROADCAST' },
      });
    });
  }

  private async storeIn(tx: Tx, request: StoreRequest): Promise<StoreResult> {
    const order = request.order;
    if (order !== null) {
      const checked = await gate(tx, order.orderId, order.attemptId);
      if (!checked.ok) return { kind: 'STOPPED', reason: checked.reason };
      if (!order.allowedTo.has(request.toAddress)) {
        await hold(tx, order.orderId, order.attemptId, 'PAY_ADDRESS_NOT_ALLOWED');
        return { kind: 'HELD', reason: holdReasonOf('PAY_ADDRESS_NOT_ALLOWED') };
      }
    }
    if ((await databaseLagSec(tx, request.chainTimeSec)) > request.maxSignLagSec) {
      return { kind: 'SKEWED' };
    }
    const busy = await tx.tonTransfer.findFirst({
      where: {
        network: request.network,
        walletAddress: request.walletAddress,
        status: { in: ['SIGNED', 'BROADCAST'] },
      },
      select: { id: true },
    });
    if (busy !== null) return { kind: 'BUSY' };
    const spent = await spentLast24h(tx, request.network, request.walletAddress);
    const limits = checkTonLimits(request.amountNano, spent, request.limits);
    if (!limits.ok) {
      if (order !== null) await hold(tx, order.orderId, order.attemptId, limits.reason);
      return { kind: 'HELD', reason: limits.reason };
    }
    const signed = request.sign();
    if (order !== null) {
      // docs/06 item 2: the reference is written once, only while the attempt is alive.
      const ref = await tx.fulfillmentAttempt.updateMany({
        where: {
          id: order.attemptId,
          externalRef: null,
          status: { in: ['SENDING', 'SENT', 'UNKNOWN'] },
        },
        data: { externalRef: signed.extMsgHash },
      });
      if (ref.count !== 1) return { kind: 'STOPPED', reason: 'REF_TAKEN' };
    }
    const transfer = await tx.tonTransfer.create({
      data: {
        purpose: order === null ? 'SELFTEST' : 'ORDER',
        attemptId: order?.attemptId ?? null,
        network: request.network,
        walletAddress: request.walletAddress,
        seqno: request.seqno,
        validUntil: new Date(request.validUntilSec * 1_000),
        toAddress: request.toAddress,
        amountNanoTon: request.amountNano,
        payloadHash: signed.payloadHash,
        extMsgHash: signed.extMsgHash,
        bocBase64: signed.bocBase64,
        status: 'SIGNED',
      },
      select: TRANSFER_SELECT,
    });
    return { kind: 'STORED', transfer, signed };
  }
}
