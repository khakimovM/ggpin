import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import { RECONCILE_BATCH_LIMIT, type OrderStatus } from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';

// The reads of the reconciler's job-less, lock and notice sweeps (phase 5 S9d). Nothing here
// writes. "Unchanged since T": no OrderEvent of the order after T (every status move writes one in
// its transaction, the creation too), or, for a row without any event, created by T. T is the
// database clock of the tick minus a window, but an OrderEvent's createdAt is written by the
// process that made the move (Prisma's `@default(now())` is filled in by the client, not by
// Postgres); only Order.createdAt is the database's. A skew between the API / worker hosts and the
// database host moves every window by that much, so phase 5 runs them on ONE host with NTP (the
// deploy check of phase 11); the windows are minutes long, a skew of seconds does not matter.
// Lists are keyset walks over (createdAt, id), oldest first, at most RECONCILE_BATCH_LIMIT rows.
// `scope()` is a hook for the e2e (narrowed to a run's orders); every query here ANDs it in, so
// the e2e runs these very bodies.

/** Where a keyset walk stopped. */
export interface SweepCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/** The states a fulfill-order run works on: one without a job stays put for ever. */
export const RUNNABLE_STATUSES: readonly OrderStatus[] = ['PAID', 'QUEUED', 'PROCESSING'];

/** States someone may still act on (a run, the reconciler, the owner): a held lock blocks them. */
export const OPEN_STATUSES: readonly OrderStatus[] = [...RUNNABLE_STATUSES, 'HELD', 'NEEDS_REVIEW'];

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit), RECONCILE_BATCH_LIMIT));
}

export function unchangedSince(before: Date): Prisma.OrderWhereInput {
  return {
    events: { none: { createdAt: { gt: before } } },
    OR: [{ events: { some: {} } }, { createdAt: { lte: before } }],
  };
}

export function afterCursor(after: SweepCursor | null): Prisma.OrderWhereInput {
  if (after === null) return {};
  return {
    OR: [
      { createdAt: { gt: after.createdAt } },
      { createdAt: after.createdAt, id: { gt: after.id } },
    ],
  };
}

/** HELD or NEEDS_REVIEW, entered (its latest move INTO that state) at or after `since`. */
export function enteredSince(since: Date): Prisma.OrderWhereInput {
  return {
    OR: [
      { status: 'HELD', events: { some: { to: 'HELD', createdAt: { gte: since } } } },
      {
        status: 'NEEDS_REVIEW',
        events: { some: { to: 'NEEDS_REVIEW', createdAt: { gte: since } } },
      },
    ],
  };
}

const PAGE = {
  select: { id: true, createdAt: true },
  orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
};

@Injectable()
export class OrderSweepsRepository {
  constructor(protected readonly prisma: PrismaService) {}

  /** Production: every order. The e2e narrows it to the orders of its run (nothing else). */
  protected scope(): Prisma.OrderWhereInput {
    return {};
  }

  /** PAID / QUEUED / PROCESSING orders unchanged since `before`, after the cursor. */
  stalePage(before: Date, after: SweepCursor | null, limit: number): Promise<SweepCursor[]> {
    return this.prisma.client.order.findMany({
      where: {
        status: { in: [...RUNNABLE_STATUSES] },
        AND: [this.scope(), unchangedSince(before), afterCursor(after)],
      },
      ...PAGE,
      take: boundedLimit(limit),
    });
  }

  /** The same question for one order, asked again under its lock. */
  async isStale(orderId: string, before: Date): Promise<boolean> {
    const row = await this.prisma.client.order.findFirst({
      where: {
        id: orderId,
        status: { in: [...RUNNABLE_STATUSES] },
        AND: [this.scope(), unchangedSince(before)],
      },
      select: { id: true },
    });
    return row !== null;
  }

  /** Of these orders, the open ones unchanged since `before` (the ids come from Redis keys). */
  async openUnchanged(ids: readonly string[], before: Date): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.client.order.findMany({
      where: {
        id: { in: [...ids] },
        status: { in: [...OPEN_STATUSES] },
        AND: [this.scope(), unchangedSince(before)],
      },
      ...PAGE,
      take: boundedLimit(ids.length),
    });
    return rows.map((row) => row.id);
  }

  /** HELD / NEEDS_REVIEW orders that entered that state at or after `since`, after the cursor. */
  noticePage(since: Date, after: SweepCursor | null, limit: number): Promise<SweepCursor[]> {
    return this.prisma.client.order.findMany({
      where: { AND: [this.scope(), enteredSince(since), afterCursor(after)] },
      ...PAGE,
      take: boundedLimit(limit),
    });
  }
}
