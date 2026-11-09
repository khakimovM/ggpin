import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma/prisma.service';

/**
 * The retention purge of the raw bank text (D-37 (10), E-25: kept 1 year). The only write the
 * `BankMessageText_guard` trigger allows on that table: "text" -> NULL once "purgeAfter" has
 * passed, every other column untouched. BankMessage (append-only) is never written.
 */
@Injectable()
export class BankTextPurgeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Erases the text of at most `limit` rows due for the purge, the oldest `purgeAfter` first
   * (the `purgeAfter` index); returns how many rows changed. The cut-off is the DATABASE clock,
   * converted to UTC exactly as the trigger does ("purgeAfter" is a UTC timestamp without zone),
   * and `now()` is the same instant in the trigger of this statement: a worker clock running
   * ahead could otherwise pick a row the trigger refuses, and that one row would fail the whole
   * batch. SKIP LOCKED lets a parallel run take other rows instead of waiting on these.
   */
  purgeBatch(limit: number): Promise<number> {
    return this.prisma.client.$executeRaw`
      UPDATE "BankMessageText" SET "text" = NULL
      WHERE "text" IS NOT NULL
        AND "bankMessageId" IN (
          SELECT "bankMessageId" FROM "BankMessageText"
          WHERE "text" IS NOT NULL AND "purgeAfter" <= timezone('UTC', now())
          ORDER BY "purgeAfter"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )`;
  }
}
