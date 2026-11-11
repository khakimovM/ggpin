import { Injectable } from '@nestjs/common';
import type { LedgerItem, LedgerQuery, WalletResponse } from '@repo/shared';
import { paginated, type WithMeta } from '../../common/http/with-meta';
import { toLedgerItem } from './entities/ledger.mapper';
import { toWalletResponse } from './entities/wallet.mapper';
import { WalletCache } from './wallet-cache';
import { WalletRepository } from './wallet.repository';

/**
 * Read side of the wallet. The balance is SUM(ledger), never stored; the cache only spares the
 * SUM. The write paths (admin adjust, payment reversal) live in WalletAdminService and delete
 * the cache after commit. Every query is scoped to `userId` from the session.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly repo: WalletRepository,
    private readonly cache: WalletCache,
  ) {}

  async getWallet(userId: string): Promise<WalletResponse> {
    return toWalletResponse(await this.balanceOf(userId));
  }

  async listLedger(userId: string, query: LedgerQuery): Promise<WithMeta<readonly LedgerItem[]>> {
    const { rows, total } = await this.repo.listLedger(userId, query);
    return paginated(rows.map(toLedgerItem), { page: query.page, limit: query.limit, total });
  }

  // Read-through: miss -> SUM -> SET EX. A cache failure is a miss, not an error.
  private async balanceOf(userId: string): Promise<bigint> {
    const cached = await this.cache.get(userId);
    if (cached !== null) return cached;
    const balance = await this.repo.balance(userId);
    await this.cache.set(userId, balance);
    return balance;
  }
}
