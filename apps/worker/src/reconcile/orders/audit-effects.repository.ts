import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import {
  ORDER_EFFECTS_ACTIONS,
  RECONCILE_BATCH_LIMIT,
  type EffectsAuditRow,
  type EffectsOrder,
  type OrderStatus,
} from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';

// The reads of the audit-effects step (phase 5 S9h, D-64 (9), I-3). Nothing here writes. The rows
// are the AuditLog rows of the four audited actions with after-commit effects, each ONLY with the
// target type its writer gives it (order-admin.repository.ts, needs-review-resolve.ts,
// fx-admin.repository.ts, the S9f hint command); the shared plan checks the pair again
// (order-effects-plan.ts), so a row that slips through here still plans nothing.
// `AuditLog.createdAt` is written by the process that wrote the row (Prisma's `@default(now())`
// is filled in by the client), not by Postgres: the window is the tick's database clock against
// that time, the same one-host-with-NTP assumption as order-sweeps.repository.ts (phase 11 deploy
// check). The window is a day long and its near edge two minutes: a skew of seconds does not
// matter. A keyset walk over (createdAt, id), oldest first, at most RECONCILE_BATCH_LIMIT rows.
// `scope()` is a hook for the e2e (narrowed to a run's rows); the list ANDs it in.

/** The (action, targetType) pairs the sweep reads: each action on its own target type only. */
export const AUDIT_EFFECTS_TARGETS: readonly {
  readonly action: string;
  readonly targetType: string;
}[] = [
  { action: ORDER_EFFECTS_ACTIONS.reviewResolve, targetType: 'Order' },
  { action: ORDER_EFFECTS_ACTIONS.retry, targetType: 'Order' },
  { action: ORDER_EFFECTS_ACTIONS.fxSet, targetType: 'FxRate' },
  { action: ORDER_EFFECTS_ACTIONS.tonTxHint, targetType: 'TonTransfer' },
];

/** Where the walk stopped. */
export interface AuditCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export type AuditEffectsRow = EffectsAuditRow & AuditCursor;

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit), RECONCILE_BATCH_LIMIT));
}

function afterCursor(after: AuditCursor | null): Prisma.AuditLogWhereInput {
  if (after === null) return {};
  return {
    OR: [
      { createdAt: { gt: after.createdAt } },
      { createdAt: after.createdAt, id: { gt: after.id } },
    ],
  };
}

@Injectable()
export class AuditEffectsRepository {
  constructor(protected readonly prisma: PrismaService) {}

  /** Production: every row. The e2e narrows it to the rows of its run (nothing else). */
  protected scope(): Prisma.AuditLogWhereInput {
    return {};
  }

  /** Rows of the four actions created in [since, until], after the cursor, oldest first. */
  page(
    since: Date,
    until: Date,
    after: AuditCursor | null,
    limit: number,
  ): Promise<AuditEffectsRow[]> {
    return this.prisma.client.auditLog.findMany({
      where: {
        createdAt: { gte: since, lte: until },
        OR: AUDIT_EFFECTS_TARGETS.map((pair) => ({ ...pair })),
        AND: [this.scope(), afterCursor(after)],
      },
      select: {
        id: true,
        action: true,
        targetType: true,
        targetId: true,
        actorType: true,
        after: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: boundedLimit(limit),
    });
  }

  /** The orders these rows are about (id, owner, status), by id. */
  async ordersOf(ids: readonly string[]): Promise<Map<string, EffectsOrder>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.client.order.findMany({
      where: { id: { in: unique } },
      select: { id: true, userId: true, status: true },
      take: boundedLimit(unique.length),
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** One order's status, read again under its lock (null: no such order). */
  async statusOf(orderId: string): Promise<OrderStatus | null> {
    const row = await this.prisma.client.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    return row?.status ?? null;
  }
}
