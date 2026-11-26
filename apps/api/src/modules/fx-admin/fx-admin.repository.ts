import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/db';
import { DERIVED_FX_SOURCE_PREFIX, MANUAL_FX_SOURCE, type FxPair } from '@repo/shared';
import type { Db } from '../../infra/prisma/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

export const FX_SET_ACTION = 'FX_SET';

export interface FxRow {
  readonly id: string;
  readonly pair: string;
  readonly rate: string;
  readonly source: string;
  readonly createdAt: Date;
}

const ROW = { id: true, pair: true, rate: true, source: true, createdAt: true } as const;

/** The lowest and the highest rate of a set, each once (one row when they are the same row). */
function distinct(rows: readonly FxRow[]): FxRow[] {
  return rows.filter((row, at) => rows.findIndex((r) => r.id === row.id) === at);
}

/**
 * All Prisma access of `fx:set` (owner CLI). FxRate is append-only; the API writes it only here,
 * in the owner's transaction (the price book still only reads it).
 *
 * The 24 h jump rule needs only the window's lowest and highest rate: a move measured against the
 * reference, |new - r| / r, is largest at the smallest r below the new rate or the largest r above
 * it. So the database picks those two rows (`rate::numeric`, safe: FxRate_rate_check holds every
 * rate to a plain decimal) and no row cap can hide an old reference (audit L-1).
 */
@Injectable()
export class FxAdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn);
  }

  get client(): Db {
    return this.prisma.client;
  }

  /** Serialises `fx:set` runs until `tx` ends, so two runs never judge against the same history. */
  async lockFxSet(tx: Db): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('ggpin:fx:set'))::text`;
  }

  /** The highest and the lowest owner's rate of `pair` created in `[since, notAfter]`. */
  async manualExtremes(db: Db, pair: FxPair, since: Date, notAfter: Date): Promise<FxRow[]> {
    const rows = await db.$queryRaw<FxRow[]>`
      (SELECT "id", "pair", "rate", "source", "createdAt" FROM "FxRate"
        WHERE "pair" = ${pair} AND "source" = ${MANUAL_FX_SOURCE}
          AND "createdAt" >= ${since} AND "createdAt" <= ${notAfter}
        ORDER BY "rate"::numeric DESC, "id" ASC LIMIT 1)
      UNION ALL
      (SELECT "id", "pair", "rate", "source", "createdAt" FROM "FxRate"
        WHERE "pair" = ${pair} AND "source" = ${MANUAL_FX_SOURCE}
          AND "createdAt" >= ${since} AND "createdAt" <= ${notAfter}
        ORDER BY "rate"::numeric ASC, "id" ASC LIMIT 1)`;
    return distinct(rows);
  }

  /**
   * The highest and the lowest derived TON_UZS rate created in `[since, notAfter]` whose two
   * parents (`derived:<TON_USDT id>*<USDT_UZS id>`) are both the owner's rows.
   */
  async manualDerivedExtremes(db: Db, since: Date, notAfter: Date): Promise<FxRow[]> {
    const prefix = DERIVED_FX_SOURCE_PREFIX;
    const rows = await db.$queryRaw<FxRow[]>`
      WITH "d" AS (
        SELECT d."id", d."pair", d."rate", d."source", d."createdAt" FROM "FxRate" d
        JOIN "FxRate" a ON a."pair" = 'TON_USDT' AND a."source" = ${MANUAL_FX_SOURCE}
          AND a."id" = split_part(substr(d."source", length(${prefix}) + 1), '*', 1)
        JOIN "FxRate" b ON b."pair" = 'USDT_UZS' AND b."source" = ${MANUAL_FX_SOURCE}
          AND b."id" = split_part(substr(d."source", length(${prefix}) + 1), '*', 2)
        WHERE d."pair" = 'TON_UZS' AND starts_with(d."source", ${prefix})
          AND d."createdAt" >= ${since} AND d."createdAt" <= ${notAfter}
      )
      (SELECT * FROM "d" ORDER BY "rate"::numeric DESC, "id" ASC LIMIT 1)
      UNION ALL
      (SELECT * FROM "d" ORDER BY "rate"::numeric ASC, "id" ASC LIMIT 1)`;
    return distinct(rows);
  }

  /** True when an owner's row of `pair` was created after `after` (the caller's clock, CLOCK). */
  async manualSetAfter(db: Db, pair: FxPair, after: Date): Promise<boolean> {
    const row = await db.fxRate.findFirst({
      where: { pair, source: MANUAL_FX_SOURCE, createdAt: { gt: after } },
      select: { id: true },
    });
    return row !== null;
  }

  /** The newest row of `pair` (any source) stamped no later than `notAfter`. */
  latest(db: Db, pair: FxPair, notAfter: Date): Promise<FxRow | null> {
    return db.fxRate.findFirst({
      where: { pair, createdAt: { lte: notAfter } },
      select: ROW,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** `createdAt` is the database's (column default), never the CLI's clock (D-35 (g)). */
  insert(tx: Db, data: { pair: FxPair; rate: string; source: string }): Promise<FxRow> {
    return tx.fxRate.create({ data, select: ROW });
  }

  createAudit(
    tx: Db,
    data: {
      targetId: string;
      before: Prisma.InputJsonObject;
      after: Prisma.InputJsonObject;
      reason: string;
      ip: string | null;
    },
  ): Promise<{ id: string }> {
    return tx.auditLog.create({
      data: {
        actorType: 'CLI',
        actorId: null,
        action: FX_SET_ACTION,
        targetType: 'FxRate',
        ...data,
      },
      select: { id: true },
    });
  }
}
