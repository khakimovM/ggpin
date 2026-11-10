import { Injectable } from '@nestjs/common';
import { readDatabaseIdentity, type DatabaseIdentity } from '@repo/db';
import type { BankFeedSource } from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** The listener's reads (rules/20: Prisma only in repositories). */
@Injectable()
export class ListenerRepository {
  constructor(private readonly prisma: PrismaService) {}

  get client() {
    return this.prisma.client;
  }

  /** The highest Telegram id stored for the source (BankFeedCursor), or null before the first. */
  async cursor(source: BankFeedSource): Promise<bigint | null> {
    const row = await this.prisma.client.bankFeedCursor.findUnique({
      where: { source },
      select: { lastMessageId: true },
    });
    return row?.lastMessageId ?? null;
  }

  /**
   * The first cursor of a source (D-52 M2): the newest message id at the first start. GREATEST
   * like IngestService: a message stored meanwhile is never moved behind.
   */
  async initCursor(source: BankFeedSource, messageId: bigint): Promise<void> {
    await this.prisma.client.$executeRaw`
      INSERT INTO "BankFeedCursor" ("source", "lastMessageId", "createdAt", "updatedAt")
      VALUES (${source}::"BankFeedSource", ${messageId}, now(), now())
      ON CONFLICT ("source") DO UPDATE
        SET "lastMessageId" = GREATEST("BankFeedCursor"."lastMessageId", EXCLUDED."lastMessageId"),
            "updatedAt" = now()`;
  }

  /** What Postgres says this connection is: its database name and dev marker (inject guard). */
  databaseIdentity(): Promise<DatabaseIdentity> {
    return readDatabaseIdentity(this.prisma.client);
  }

  /** The stored row of a bot's message, by the unique (senderId, tgMessageId). */
  async storedMessage(
    senderId: bigint,
    tgMessageId: bigint,
  ): Promise<{ readonly id: string; readonly rejectReason: string | null } | null> {
    return this.prisma.client.bankMessage.findUnique({
      where: { senderId_tgMessageId: { senderId, tgMessageId } },
      select: { id: true, rejectReason: true },
    });
  }

  /** The balance after the source's latest parsed message of these card digits (fake inject tool). */
  async lastBalance(source: BankFeedSource, last4: string): Promise<bigint | null> {
    const row = await this.prisma.client.bankMessage.findFirst({
      where: { source, last4, parseStatus: 'PARSED' },
      orderBy: { tgMessageId: 'desc' },
      select: { balanceAfterTiyin: true },
    });
    return row?.balanceAfterTiyin ?? null;
  }
}
