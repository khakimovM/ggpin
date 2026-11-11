import { Injectable } from '@nestjs/common';
import { readDatabaseIdentity, type DatabaseIdentity, type Prisma } from '@repo/db';
import type { BankFeedSource } from '@repo/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * Rows of the source's own chat (the re-scan's OWN_CHAT, reconcile.repository.ts): never an older
 * FOREIGN_CHAT row (B2). An OR, because `rejectReason <> 'FOREIGN_CHAT'` alone would also drop
 * every NULL (accepted) row.
 */
const OWN_CHAT = {
  OR: [{ rejectReason: null }, { rejectReason: { not: 'FOREIGN_CHAT' } }],
} satisfies Prisma.BankMessageWhereInput;

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

  /**
   * The stored row of a message of the source's own bot chat, by (source, tgMessageId) like the
   * re-scan's `knownIds`: NOT by the pinned bot as sender, because the account's own (OUTGOING)
   * message is stored with the account's id as `senderId` (review M1). There is no unique key on
   * these two columns, hence `findFirst`; at most one row can match: the account has ONE id
   * sequence for its private chats (BankFeedMessage.id), a private-chat message has exactly one
   * author, and ingest stores each (senderId, tgMessageId) once. Older FOREIGN_CHAT rows (B2) carry
   * another chat's numbering and are left out, as in the re-scan. Oldest first only so the answer
   * stays stable should that reasoning ever fail.
   */
  async storedMessage(
    source: BankFeedSource,
    tgMessageId: bigint,
  ): Promise<{ readonly id: string; readonly rejectReason: string | null } | null> {
    return this.prisma.client.bankMessage.findFirst({
      where: { source, tgMessageId, ...OWN_CHAT },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
