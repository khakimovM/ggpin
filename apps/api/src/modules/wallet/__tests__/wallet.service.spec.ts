import type { LedgerEntry } from '@repo/db';
import type { WalletCache } from '../wallet-cache';
import type { WalletRepository } from '../wallet.repository';
import { WalletService } from '../wallet.service';

function setup(cached: bigint | null = null, balance = 777n) {
  const repo = {
    balance: jest.fn().mockResolvedValue(balance),
    listLedger: jest.fn(),
  };
  const cache = {
    get: jest.fn().mockResolvedValue(cached),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const service = new WalletService(
    repo as unknown as WalletRepository,
    cache as unknown as WalletCache,
  );
  return { service, repo, cache };
}

describe('WalletService.getWallet (read-through cache)', () => {
  it('miss: sums the ledger, stores the result, answers with it', async () => {
    const { service, repo, cache } = setup(null, 2_034_100n);
    await expect(service.getWallet('u1')).resolves.toEqual({
      balanceTiyin: '2034100',
      coins: '0',
      currency: 'UZS',
    });
    expect(repo.balance).toHaveBeenCalledWith('u1');
    expect(cache.set).toHaveBeenCalledWith('u1', 2_034_100n);
  });

  it('hit: answers from the cache without touching the database', async () => {
    const { service, repo, cache } = setup(5n);
    await expect(service.getWallet('u1')).resolves.toMatchObject({ balanceTiyin: '5' });
    expect(repo.balance).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('a cached zero is a hit, not a miss', async () => {
    const { service, repo } = setup(0n);
    await expect(service.getWallet('u1')).resolves.toMatchObject({ balanceTiyin: '0' });
    expect(repo.balance).not.toHaveBeenCalled();
  });

  it('a cached negative balance keeps its sign', async () => {
    const { service } = setup(-550_000n);
    await expect(service.getWallet('u1')).resolves.toMatchObject({ balanceTiyin: '-550000' });
  });
});

describe('WalletService.listLedger', () => {
  it('passes the owner and the query to the repository and maps rows + meta', async () => {
    const { service, repo } = setup();
    const row: LedgerEntry = {
      id: 'l1',
      userId: 'u1',
      kind: 'TOPUP',
      amountTiyin: 100n,
      refType: 'PAYMENT',
      refId: 'p1',
      note: null,
      createdAt: new Date('2026-11-04T10:05:00.000Z'),
    };
    repo.listLedger.mockResolvedValue({ rows: [row], total: 41 });
    const query = { kind: 'TOPUP' as const, page: 2, limit: 20 };

    const result = await service.listLedger('u1', query);

    expect(repo.listLedger).toHaveBeenCalledWith('u1', query);
    expect(result.meta).toEqual({ page: 2, limit: 20, total: 41 });
    expect(result.data).toEqual([
      {
        id: 'l1',
        kind: 'TOPUP',
        amountTiyin: '100',
        createdAt: '2026-11-04T10:05:00.000Z',
        orderId: null,
        paymentId: 'p1',
      },
    ]);
  });
});
