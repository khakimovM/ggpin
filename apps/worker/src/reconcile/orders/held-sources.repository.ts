import { Inject, Injectable } from '@nestjs/common';
import {
  COST_MAX_AGE_MS,
  MAX_CLOCK_SKEW_MS,
  MoneyError,
  RECONCILE_BATCH_LIMIT,
  costForQuantity,
} from '@repo/shared';
import type { Prisma } from '@repo/db';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { BALANCE_CHECK_EVERY_MS } from '../../ton/ton-balance.monitor';
import { spentLast24h } from '../../ton/ton-sign-guards';
import type { PrismaHolder } from '../../ton/ton-transfer.repository';
import { HELD_EXPIRED_NOTE, RECONCILE_RELEASE_NOTE_PREFIX } from './held-release-policy';
import type { WalletScope } from './order-reconcile.repository';
import { afterCursor, type SweepCursor } from './order-sweeps.repository';

// The reads of the S9e steps (phase 5 S9e): the HELD orders and the facts their release policy
// needs, the HELD_EXPIRED refunds whose effects are sent again, and the transfers that keep the hot
// wallet blocked. Nothing here writes. Clocks are the database's (the tick's `nowMs`); lists are
// keyset walks over (createdAt, id), oldest first, at most RECONCILE_BATCH_LIMIT rows. `scope()`
// narrows the two order lists for an e2e run (like OrderSweepsRepository); production: every order.

/** A WalletSnapshot older than this says nothing about the balance now (3 monitor ticks). */
export const WALLET_SNAPSHOT_FRESH_MS = 3 * BALANCE_CHECK_EVERY_MS;

export interface HeldOrder {
  readonly id: string;
  readonly userId: string;
  readonly statusReason: string | null;
  readonly productId: string;
  readonly skuId: string | null;
  readonly quantity: number;
  readonly providerRef: string | null;
  readonly costCurrency: string;
  readonly costMinor: bigint;
  readonly maxCostMinor: bigint;
  readonly createdAt: Date;
  /** The latest HELD event's time, and how many HELD events the order has (the hold fence). */
  readonly heldAt: Date;
  readonly heldEvents: number;
  /** PURCHASE of the order: the owner's, and exactly `priceTiyin - discountTiyin` taken. */
  readonly purchaseMatches: boolean;
  /** HELD -> QUEUED moves the reconciler made (`reconcile release: ...` by SYSTEM). */
  readonly releasesUsed: number;
  /** The order's latest attempt (its adapter keeps the route, its cost was the refused one). */
  readonly lastAttempt: { readonly adapter: string; readonly costMinor: bigint | null } | null;
}

/**
 * What a look at one order found: no longer HELD, HELD without any HELD event (the history guard
 * was bypassed: never acted on, the owner is told), or the facts of its hold.
 */
export type HeldLook =
  | { readonly kind: 'gone' }
  | { readonly kind: 'noHeldEvent' }
  | { readonly kind: 'held'; readonly order: HeldOrder };

/** Where a refund's effects go again: the order and its owner. */
export interface RefundedOrder extends SweepCursor {
  readonly userId: string;
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit), RECONCILE_BATCH_LIMIT));
}

const PAGE = {
  select: { id: true, createdAt: true },
  orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
};

/** The rows a reconciler release writes (and only it). */
export function reconcilerReleaseWhere(orderId: string) {
  return {
    orderId,
    from: 'HELD' as const,
    to: 'QUEUED' as const,
    actor: 'SYSTEM',
    note: { startsWith: RECONCILE_RELEASE_NOTE_PREFIX },
  };
}

@Injectable()
export class HeldSourcesRepository {
  constructor(@Inject(PrismaService) protected readonly prisma: PrismaHolder) {}

  /** Production: every order. The e2e narrows it to the orders of its run (nothing else). */
  protected scope(): Prisma.OrderWhereInput {
    return {};
  }

  /** HELD orders after the cursor, oldest first. */
  heldPage(after: SweepCursor | null, limit: number): Promise<SweepCursor[]> {
    return this.prisma.client.order.findMany({
      where: { status: 'HELD', AND: [this.scope(), afterCursor(after)] },
      ...PAGE,
      take: boundedLimit(limit),
    });
  }

  /** The order with every fact the policy reads, when it is (still) HELD with a HELD event. */
  async heldOrder(orderId: string): Promise<HeldLook> {
    const db = this.prisma.client;
    const order = await db.order.findFirst({
      where: { id: orderId, status: 'HELD' },
      select: {
        id: true,
        userId: true,
        statusReason: true,
        productId: true,
        skuId: true,
        quantity: true,
        providerRef: true,
        costCurrency: true,
        costMinor: true,
        maxCostMinor: true,
        priceTiyin: true,
        discountTiyin: true,
        createdAt: true,
      },
    });
    if (order === null) return { kind: 'gone' };
    const [held, purchase, releasesUsed, lastAttempt] = await Promise.all([
      db.orderEvent.aggregate({
        where: { orderId, to: 'HELD' },
        _max: { createdAt: true },
        _count: { _all: true },
      }),
      db.ledgerEntry.findUnique({
        where: { refType_refId_kind: { refType: 'ORDER', refId: orderId, kind: 'PURCHASE' } },
        select: { userId: true, amountTiyin: true },
      }),
      db.orderEvent.count({ where: reconcilerReleaseWhere(orderId) }),
      db.fulfillmentAttempt.findFirst({
        where: { orderId },
        orderBy: { attemptNo: 'desc' },
        select: { adapter: true, costMinor: true },
      }),
    ]);
    const heldAt = held._max.createdAt;
    // A HELD order without a HELD event breaks the history guard: never acted on (S9e fix CR F4).
    if (heldAt === null) return { kind: 'noHeldEvent' };
    const { priceTiyin, discountTiyin, ...rest } = order;
    const facts: HeldOrder = {
      ...rest,
      heldAt,
      heldEvents: held._count._all,
      purchaseMatches:
        purchase !== null &&
        purchase.userId === order.userId &&
        -purchase.amountTiyin === priceTiyin - discountTiyin,
      releasesUsed,
      lastAttempt,
    };
    return { kind: 'held', order: facts };
  }

  /**
   * The order's quantity at the adapter's newest cost snapshot of the order's currency that is
   * fresh (COST_MAX_AGE_MS, the quote's own rule): the SKU's pack row first, else the product row
   * scaled (rounded up). Null when none is fresh or the numbers do not fit.
   */
  async freshCost(order: HeldOrder, adapter: string, nowMs: number): Promise<bigint | null> {
    const window = {
      gte: new Date(nowMs - COST_MAX_AGE_MS),
      lte: new Date(nowMs + MAX_CLOCK_SKEW_MS),
    };
    const latest = (skuId: string | null) =>
      this.prisma.client.costSnapshot.findFirst({
        where: {
          productId: order.productId,
          skuId,
          adapter,
          currency: order.costCurrency,
          createdAt: window,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { costMinor: true, basisQuantity: true },
      });
    const pack = order.skuId === null ? null : await latest(order.skuId);
    const row = pack ?? (await latest(null));
    if (row === null) return null;
    try {
      return costForQuantity({
        snapshotCostMinor: row.costMinor,
        basisQuantity: row.basisQuantity,
        quantity: order.quantity,
        scope: pack === null ? 'product' : 'sku',
      });
    } catch (error) {
      if (error instanceof MoneyError) return null;
      throw error;
    }
  }

  /** The hot wallet's newest balance reading younger than WALLET_SNAPSHOT_FRESH_MS, or null. */
  async freshBalance(wallet: WalletScope, nowMs: number): Promise<bigint | null> {
    const row = await this.prisma.client.walletSnapshot.findFirst({
      where: {
        network: wallet.network,
        address: wallet.rawAddress,
        createdAt: {
          gte: new Date(nowMs - WALLET_SNAPSHOT_FRESH_MS),
          lte: new Date(nowMs + MAX_CLOCK_SKEW_MS),
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { nanoTon: true },
    });
    return row?.nanoTon ?? null;
  }

  /** The rolling 24 h payout sum of the wallet: the signing transaction's own query. */
  spentLast24h(wallet: WalletScope): Promise<bigint> {
    return this.prisma.client.$transaction((tx) =>
      spentLast24h(tx, wallet.network, wallet.rawAddress),
    );
  }

  /**
   * REFUNDED orders the RECONCILER refunded for HELD_EXPIRED (its own HELD -> FAILED event: SYSTEM,
   * HELD_EXPIRED_NOTE; an operator's refund with the same reason is not one, S9e fix CR F5) whose
   * refund (FAILED -> REFUNDED event) is at or after `since`, after the cursor: their stable
   * effects are queued again inside the window.
   */
  expiredRefundsSince(
    since: Date,
    after: SweepCursor | null,
    limit: number,
  ): Promise<RefundedOrder[]> {
    return this.prisma.client.order.findMany({
      where: {
        status: 'REFUNDED',
        statusReason: 'HELD_EXPIRED',
        AND: [
          this.scope(),
          { events: { some: { from: 'FAILED', to: 'REFUNDED', createdAt: { gte: since } } } },
          {
            events: {
              some: { from: 'HELD', to: 'FAILED', actor: 'SYSTEM', note: HELD_EXPIRED_NOTE },
            },
          },
          afterCursor(after),
        ],
      },
      select: { id: true, createdAt: true, userId: true },
      orderBy: PAGE.orderBy,
      take: boundedLimit(limit),
    });
  }

  /**
   * Unresolved transfers (any purpose) of this worker's wallet and network created before
   * `before`: each blocks every payout of the wallet. Oldest first.
   */
  blockingTransfers(wallet: WalletScope, before: Date, limit: number) {
    return this.prisma.client.tonTransfer.findMany({
      where: {
        network: wallet.network,
        walletAddress: wallet.rawAddress,
        status: { in: ['SIGNED', 'BROADCAST'] },
        createdAt: { lt: before },
      },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: boundedLimit(limit),
    });
  }
}
