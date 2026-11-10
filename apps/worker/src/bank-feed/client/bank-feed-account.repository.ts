import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { BankFeedAuthorization } from './bank-feed-client';

/**
 * How the session's account compares with the bound one (D-52 D4). UNBOUND_HISTORY (r2, review
 * L-B): no account is bound, yet a cursor or a stored bank message exists, so the row was deleted
 * (someone "fixing" an ACCOUNT_MISMATCH); binding now would tie the old cursor to whatever account
 * this session is. Refused: listenerStopped ACCOUNT_UNBOUND (runbook item 3).
 */
export type AccountCheck = 'BOUND' | 'MATCH' | 'MISMATCH' | 'UNBOUND_HISTORY';

/**
 * The bank-feed working account in Postgres (D-52 D1, replaces the Redis set): the account the
 * session belongs to (BankFeedAccount, one row) and the authorizations seen so far
 * (BankFeedAuthorization). A flushed Redis no longer resets anything. Never an IP, a country or
 * a region (the client does not even read them).
 */
@Injectable()
export class BankFeedAccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Binds the first account ever seen; afterwards only that one matches. Account switching is
   * not supported yet (a later slice): a session of another account is MISMATCH (fail closed).
   */
  async check(accountId: bigint): Promise<AccountCheck> {
    const bound = await this.boundAccount();
    if (bound !== null) return bound === accountId ? 'MATCH' : 'MISMATCH';
    if (await this.hasHistory()) return 'UNBOUND_HISTORY';
    // ON CONFLICT DO NOTHING on the one-row slot: two workers binding at once keep the first.
    const { count } = await this.prisma.client.bankFeedAccount.createMany({
      data: [{ telegramUserId: accountId }],
      skipDuplicates: true,
    });
    if (count === 1) return 'BOUND';
    return (await this.boundAccount()) === accountId ? 'MATCH' : 'MISMATCH';
  }

  /** When the account was bound (the first live start; setup messages are older), or null. */
  async boundAt(): Promise<Date | null> {
    const row = await this.prisma.client.bankFeedAccount.findUnique({
      where: { slot: 1 },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  private async boundAccount(): Promise<bigint | null> {
    const row = await this.prisma.client.bankFeedAccount.findUnique({
      where: { slot: 1 },
      select: { telegramUserId: true },
    });
    return row?.telegramUserId ?? null;
  }

  /** Any cursor or stored message: the feed has run before (an e2e seam overrides it). */
  protected async hasHistory(): Promise<boolean> {
    const cursor = await this.prisma.client.bankFeedCursor.findFirst({ select: { source: true } });
    if (cursor !== null) return true;
    const message = await this.prisma.client.bankMessage.findFirst({ select: { id: true } });
    return message !== null;
  }

  async knownHashes(): Promise<ReadonlySet<string>> {
    const rows = await this.prisma.client.bankFeedAuthorization.findMany({
      select: { hash: true },
    });
    return new Set(rows.map((r) => r.hash));
  }

  /** Remembers these authorizations (already known ones are skipped). */
  async remember(list: readonly BankFeedAuthorization[]): Promise<void> {
    if (list.length === 0) return;
    await this.prisma.client.bankFeedAuthorization.createMany({
      data: list.map((a) => ({
        hash: a.hash,
        appName: a.appName,
        deviceModel: a.deviceModel,
        authCreatedAt: a.createdAt,
      })),
      skipDuplicates: true,
    });
  }
}
