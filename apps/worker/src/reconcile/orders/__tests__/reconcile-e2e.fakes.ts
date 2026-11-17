import type { Prisma, PrismaClient } from '@repo/db';
import type { LockStore } from '../../../bank-feed/client/leader-lock';
import type { TonLease } from '../../../ton/ton-lock';
import { TonWalletLock } from '../../../ton/ton-lock';
import type { TonSenderService } from '../../../ton/ton-sender.service';
import type { PrismaHolder } from '../../../ton/ton-transfer.repository';
import {
  OrderReconcileRepository,
  type PendingTransfer,
  type ReviewCursor,
  type WalletScope,
} from '../order-reconcile.repository';
import { OrderSweepsRepository } from '../order-sweeps.repository';
import type { PrismaService } from '../../../infra/prisma/prisma.service';

// The order reconciler e2e's stand-ins and row helpers (reconcile-e2e.harness.ts).

/** A lock store that always grants: only the database fence stands between two reconcilers. */
export class GrantingLockStore implements LockStore {
  acquire(): Promise<boolean> {
    return Promise.resolve(true);
  }

  renew(): Promise<boolean> {
    return Promise.resolve(true);
  }

  release(): Promise<void> {
    return Promise.resolve();
  }
}

/** The real repository, its two lists narrowed to the orders this run created. */
export class ScopedReconcileRepository extends OrderReconcileRepository {
  constructor(
    private readonly holder: PrismaHolder,
    private readonly orders: ReadonlySet<string>,
  ) {
    super(holder);
  }

  override async pendingTransfers(wallet: WalletScope, limit: number): Promise<PendingTransfer[]> {
    const rows = await this.holder.client.tonTransfer.findMany({
      where: {
        purpose: 'ORDER',
        status: { in: ['SIGNED', 'BROADCAST'] },
        network: wallet.network,
        walletAddress: wallet.rawAddress,
        attempt: { orderId: { in: [...this.orders] } },
      },
      select: {
        id: true,
        network: true,
        walletAddress: true,
        attempt: { select: { orderId: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map((r) => ({ ...r, orderId: r.attempt?.orderId ?? null }));
  }

  override foreignPendingCount(wallet: WalletScope): Promise<number> {
    return this.holder.client.tonTransfer.count({
      where: {
        purpose: 'ORDER',
        status: { in: ['SIGNED', 'BROADCAST'] },
        attempt: { orderId: { in: [...this.orders] } },
        OR: [{ network: { not: wallet.network } }, { walletAddress: { not: wallet.rawAddress } }],
      },
    });
  }

  override reviewPage(_after: ReviewCursor | null, limit: number): Promise<ReviewCursor[]> {
    return this.holder.client.order.findMany({
      where: { status: 'NEEDS_REVIEW', id: { in: [...this.orders] } },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }
}

/** The real sweep reads (their production bodies), every list narrowed to the orders of this run. */
export class ScopedSweepsRepository extends OrderSweepsRepository {
  constructor(
    prisma: PrismaService,
    private readonly orders: ReadonlySet<string>,
  ) {
    super(prisma);
  }

  protected override scope(): Prisma.OrderWhereInput {
    return { id: { in: [...this.orders] } };
  }
}

/**
 * The reconciler's module gets a sender and a wallet lock that count every call and fail it
 * (S9c review CR5, audit L-2): the static checks prove the reconciler's code names neither, these
 * prove no path through the TON module it calls reaches them either. The harness asserts both
 * counts are zero after every test; a swallowed failure still shows in the count.
 */
export class ReconcilerTraps {
  private payCalls = 0;
  private lockCalls = 0;

  sender(): Pick<TonSenderService, 'pay'> {
    return {
      pay: () => {
        this.payCalls += 1;
        return Promise.reject(new Error('the order reconciler called TonSenderService.pay'));
      },
    };
  }

  walletLock(): TonWalletLock {
    const count = (): void => {
      this.lockCalls += 1;
    };
    return new (class extends TonWalletLock {
      override acquire(): Promise<TonLease | null> {
        count();
        return Promise.reject(new Error('the order reconciler took the TON wallet lock'));
      }
    })(new GrantingLockStore(), 'lock:reconciler-trap', 1_000);
  }

  calls(): { readonly pay: number; readonly walletLock: number } {
    return { pay: this.payCalls, walletLock: this.lockCalls };
  }
}

const asObject = (value: Prisma.JsonValue | undefined): Prisma.JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};

/**
 * One chain fact in an attempt's `response.ton` (where the TON module's outcome writes keep them:
 * `suspect`, `witnessConflict`), the rest of the response kept.
 */
export async function writeTonFact(
  db: PrismaClient,
  attemptId: string,
  fact: 'suspect' | 'witnessConflict',
  value: Prisma.InputJsonObject,
): Promise<void> {
  const row = await db.fulfillmentAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: { response: true },
  });
  const response = asObject(row.response);
  const ton = { ...asObject(response['ton']), [fact]: value };
  await db.fulfillmentAttempt.update({
    where: { id: attemptId },
    data: { response: { ...response, ton } },
  });
}
