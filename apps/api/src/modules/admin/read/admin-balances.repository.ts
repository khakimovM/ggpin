import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { WalletCache } from '../../wallet/wallet-cache';

/**
 * Wallet balances for the admin user screens: SUM(ledger) through the `wallet:{userId}` cache,
 * the same read-through as the user's own wallet (WalletService). A list page reads the cache
 * for every user in ONE MGET, sums only the misses in ONE grouped query and writes them back in
 * ONE pipeline. Display only: no money decision is made on these numbers.
 */
@Injectable()
export class AdminBalancesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: WalletCache,
  ) {}

  async of(userIds: readonly string[]): Promise<Map<string, bigint>> {
    const balances = await this.cache.getMany(userIds);
    const misses = userIds.filter((id) => !balances.has(id));
    if (misses.length === 0) return balances;
    const sums = await this.prisma.client.ledgerEntry.groupBy({
      by: ['userId'],
      where: { userId: { in: misses } },
      _sum: { amountTiyin: true },
    });
    const byUser = new Map(sums.map((row) => [row.userId, row._sum.amountTiyin ?? 0n]));
    const computed = new Map(misses.map((id): [string, bigint] => [id, byUser.get(id) ?? 0n]));
    await this.cache.setMany(computed);
    for (const [id, balance] of computed) balances.set(id, balance);
    return balances;
  }

  async one(userId: string): Promise<bigint> {
    return (await this.of([userId])).get(userId) ?? 0n;
  }
}
